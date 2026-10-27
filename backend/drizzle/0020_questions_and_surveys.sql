CREATE TABLE "questions" (
	"comment_id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"items" jsonb NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"expected_respondent_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"answer" jsonb,
	"answered_by" uuid,
	"answered_at" timestamp with time zone,
	"answer_comment_id" uuid,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"result_comment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "survey_responses_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "answers_comment_id" uuid;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answer_comment_id_comments_id_fk" FOREIGN KEY ("answer_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_result_comment_id_comments_id_fk" FOREIGN KEY ("result_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_comment_id_questions_comment_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."questions"("comment_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_answers_comment_id_comments_id_fk" FOREIGN KEY ("answers_comment_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;