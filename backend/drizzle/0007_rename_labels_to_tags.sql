-- Labels are called Tags. Rename the tables, columns and constraint names, and the stored Revision field.
ALTER TABLE "labels" RENAME TO "tags";--> statement-breakpoint
ALTER TABLE "task_labels" RENAME TO "task_tags";--> statement-breakpoint
ALTER TABLE "task_tags" RENAME COLUMN "label_id" TO "tag_id";--> statement-breakpoint
ALTER TABLE "tags" RENAME CONSTRAINT "labels_project_id_projects_id_fk" TO "tags_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "task_tags" RENAME CONSTRAINT "task_labels_task_id_tasks_id_fk" TO "task_tags_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_tags" RENAME CONSTRAINT "task_labels_label_id_labels_id_fk" TO "task_tags_tag_id_tags_id_fk";--> statement-breakpoint
ALTER TABLE "task_tags" RENAME CONSTRAINT "task_labels_task_id_label_id_pk" TO "task_tags_task_id_tag_id_pk";--> statement-breakpoint
ALTER INDEX "labels_name_unique" RENAME TO "tags_name_unique";--> statement-breakpoint
ALTER INDEX "task_labels_label_idx" RENAME TO "task_tags_tag_idx";--> statement-breakpoint
UPDATE "task_revisions" SET "changes" = replace("changes"::text, '"field": "labelIds"', '"field": "tagIds"')::jsonb WHERE "changes"::text LIKE '%"labelIds"%';
