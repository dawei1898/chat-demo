CREATE TABLE "attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"upload_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"is_image" boolean NOT NULL,
	"purpose" text NOT NULL,
	"provider_file_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_code" text,
	"cleanup_pending" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "attachment_size_valid" CHECK ("attachment"."size_bytes">0 AND "attachment"."size_bytes"<=8388608),
	CONSTRAINT "attachment_status_valid" CHECK ("attachment"."status" IN ('pending','ready','failed','unknown','deleted')),
	CONSTRAINT "attachment_ready_has_provider" CHECK ("attachment"."status"<>'ready' OR "attachment"."provider_file_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "attachment_reference" (
	"attachment_id" text NOT NULL,
	"message_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachment" ADD CONSTRAINT "attachment_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_reference" ADD CONSTRAINT "attachment_reference_attachment_id_attachment_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachment_reference" ADD CONSTRAINT "attachment_reference_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_owner_upload_key" ON "attachment" USING btree ("user_id","upload_key");--> statement-breakpoint
CREATE INDEX "attachment_owner_status" ON "attachment" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "attachment_message_unique" ON "attachment_reference" USING btree ("attachment_id","message_id");