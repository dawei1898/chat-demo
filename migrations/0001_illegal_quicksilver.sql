CREATE UNIQUE INDEX "conversation_id_owner" ON "conversation" USING btree ("id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_one_running_per_conversation" ON "generation_run" USING btree ("conversation_id") WHERE "generation_run"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "message_id_conversation" ON "message" USING btree ("id","conversation_id");--> statement-breakpoint
-- Additive integrity migration. No rows are rewritten or removed. Existing invalid
-- data aborts the transaction; fix it deliberately before retrying this migration.
ALTER TABLE message ADD CONSTRAINT message_payload_identity CHECK (
  jsonb_typeof(payload) = 'object'
  AND (payload->>'id') IS NOT DISTINCT FROM id
  AND ((payload->>'role') IN ('user','assistant')) IS TRUE
  AND (payload->>'parentId') IS NOT DISTINCT FROM parent_id
  AND (payload->>'selectedChildId') IS NOT DISTINCT FROM selected_child_id
  AND parent_id IS DISTINCT FROM id
  AND selected_child_id IS DISTINCT FROM id
);
--> statement-breakpoint
ALTER TABLE message ADD CONSTRAINT message_parent_same_conversation
  FOREIGN KEY(parent_id,conversation_id) REFERENCES message(id,conversation_id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE message ADD CONSTRAINT message_selected_same_conversation
  FOREIGN KEY(selected_child_id,conversation_id) REFERENCES message(id,conversation_id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE conversation ADD CONSTRAINT conversation_root_same_conversation
  FOREIGN KEY(root_message_id,id) REFERENCES message(id,conversation_id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE generation_run ADD CONSTRAINT generation_owner_matches_conversation
  FOREIGN KEY(conversation_id,user_id) REFERENCES conversation(id,user_id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE generation_run ADD CONSTRAINT generation_message_same_conversation
  FOREIGN KEY(message_id,conversation_id) REFERENCES message(id,conversation_id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint
ALTER TABLE generation_run ADD CONSTRAINT generation_status_valid
  CHECK(status IN ('running','done','stopped','error','interrupted'));
--> statement-breakpoint
ALTER TABLE generation_run ADD CONSTRAINT generation_operation_valid
  CHECK(operation IN ('send','edit','regenerate','continue'));
--> statement-breakpoint
-- Serialize graph-changing writes per conversation, including direct SQL clients.
-- App code already takes this lock. The DB lock closes concurrent write-skew gaps.
CREATE FUNCTION lock_message_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
    RAISE EXCEPTION 'message conversation is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM id FROM conversation WHERE id=OLD.conversation_id FOR UPDATE;
    RETURN OLD;
  END IF;
  PERFORM id FROM conversation WHERE id=NEW.conversation_id FOR UPDATE;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER message_graph_lock BEFORE INSERT OR UPDATE OF conversation_id,parent_id,selected_child_id,payload OR DELETE ON message
  FOR EACH ROW EXECUTE FUNCTION lock_message_conversation();
--> statement-breakpoint
CREATE FUNCTION assert_conversation_root(p_conversation_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE root_id text;
BEGIN
  SELECT root_message_id INTO root_id FROM conversation WHERE id=p_conversation_id;
  IF NOT FOUND THEN RETURN; END IF; -- parent conversation may have been cascade-deleted
  IF root_id IS NULL THEN
    IF EXISTS(SELECT 1 FROM message WHERE conversation_id=p_conversation_id) THEN
      RAISE EXCEPTION 'nonempty conversation needs selected root' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM message WHERE id=root_id AND conversation_id=p_conversation_id
                   AND parent_id IS NULL AND payload->>'role'='user') THEN
    RAISE EXCEPTION 'selected root must be a root user message' USING ERRCODE='23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION assert_message_graph(p_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE node message%ROWTYPE;
BEGIN
  SELECT * INTO node FROM message WHERE id=p_id;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM assert_conversation_root(node.conversation_id);
  IF node.parent_id IS NULL THEN
    IF node.payload->>'role' <> 'user' THEN
      RAISE EXCEPTION 'alternative root must have user role' USING ERRCODE='23514';
    END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM message p WHERE p.id=node.parent_id
      AND p.conversation_id=node.conversation_id AND p.payload->>'role' <> node.payload->>'role') THEN
    RAISE EXCEPTION 'parent must belong to same conversation and alternate roles' USING ERRCODE='23514';
  END IF;
  IF node.selected_child_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM message child
       WHERE child.id=node.selected_child_id AND child.conversation_id=node.conversation_id AND child.parent_id=node.id) THEN
    RAISE EXCEPTION 'selected child must be direct child' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM message p WHERE p.conversation_id=node.conversation_id
      AND p.selected_child_id=node.id AND p.id IS DISTINCT FROM node.parent_id) THEN
    RAISE EXCEPTION 'node is selected by a non-parent' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM message child WHERE child.conversation_id=node.conversation_id
      AND child.parent_id=node.id AND child.payload->>'role'=node.payload->>'role') THEN
    RAISE EXCEPTION 'child role must alternate' USING ERRCODE='23514';
  END IF;
  IF node.payload->>'role' <> 'assistant' AND EXISTS(SELECT 1 FROM generation_run WHERE message_id=node.id) THEN
    RAISE EXCEPTION 'generation message must have assistant role' USING ERRCODE='23514';
  END IF;
  IF EXISTS(
    WITH RECURSIVE ancestors(id,parent_id) AS (
      SELECT id,parent_id FROM message WHERE id=node.parent_id AND conversation_id=node.conversation_id
      UNION
      SELECT p.id,p.parent_id FROM message p JOIN ancestors a ON p.id=a.parent_id WHERE p.conversation_id=node.conversation_id
    ) SELECT 1 FROM ancestors WHERE id=node.id
  ) THEN
    RAISE EXCEPTION 'message ancestry cycle' USING ERRCODE='23514';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION check_message_graph() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM assert_conversation_root(OLD.conversation_id);
  ELSE
    PERFORM assert_message_graph(NEW.id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER message_graph_integrity AFTER INSERT OR UPDATE OF conversation_id,parent_id,selected_child_id,payload OR DELETE ON message
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_message_graph();
--> statement-breakpoint
CREATE FUNCTION check_conversation_root() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_conversation_root(NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER conversation_root_integrity AFTER INSERT OR UPDATE OF root_message_id ON conversation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_conversation_root();
--> statement-breakpoint
CREATE FUNCTION check_generation_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM generation_run r JOIN message m ON m.id=r.message_id WHERE r.id=NEW.id
      AND (m.conversation_id<>r.conversation_id OR m.payload->>'role'<>'assistant')) THEN
    RAISE EXCEPTION 'generation must reference an assistant in its conversation' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER generation_message_integrity AFTER INSERT OR UPDATE OF message_id,conversation_id ON generation_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_generation_message();
--> statement-breakpoint
-- Triggers do not automatically validate historical rows. Explicitly validate them
-- in the same migration transaction so partial installation cannot succeed.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT id FROM conversation LOOP PERFORM assert_conversation_root(item.id); END LOOP;
  FOR item IN SELECT id FROM message LOOP PERFORM assert_message_graph(item.id); END LOOP;
  IF EXISTS(SELECT 1 FROM generation_run r JOIN message m ON m.id=r.message_id WHERE m.payload->>'role'<>'assistant') THEN
    RAISE EXCEPTION 'existing generation message has invalid role' USING ERRCODE='23514';
  END IF;
END;
$$;
