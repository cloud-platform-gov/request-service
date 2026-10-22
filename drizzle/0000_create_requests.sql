CREATE TYPE "public"."request_status" AS ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" "request_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_title_length" CHECK (char_length(btrim("requests"."title")) between 1 and 200),
	CONSTRAINT "requests_description_length" CHECK ("requests"."description" is null or char_length("requests"."description") <= 2000)
);
--> statement-breakpoint
CREATE INDEX "requests_user_id_created_at_idx" ON "requests" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);