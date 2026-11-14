CREATE TABLE "usage_record" (
	"generation_id" text PRIMARY KEY NOT NULL,
	"input_tokens" bigint,
	"cached_input_tokens" bigint,
	"output_tokens" bigint,
	"raw_usage" jsonb,
	"completeness" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_counts_nonnegative" CHECK ("usage_record"."input_tokens" >= 0 AND "usage_record"."cached_input_tokens" >= 0 AND "usage_record"."output_tokens" >= 0),
	CONSTRAINT "usage_completeness_valid" CHECK ("usage_record"."completeness" IN ('unknown','partial','complete'))
);
--> statement-breakpoint
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_generation_id_generation_run_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generation_run"("id") ON DELETE no action ON UPDATE no action;