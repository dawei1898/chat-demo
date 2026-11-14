CREATE TABLE "auth_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"reset_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_rate_count_positive" CHECK ("auth_rate_limit"."count" > 0)
);
--> statement-breakpoint
ALTER TABLE "generation_run" ADD COLUMN "auth_session_id" text;--> statement-breakpoint
CREATE INDEX "auth_rate_expiry" ON "auth_rate_limit" USING btree ("reset_at");