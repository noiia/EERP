package project

import (
	"context"
	"fmt"
	"slices"

	"core/orm"
)

// Migrate adds what struct tags can't express: unique live pairs, CHECKs,
// column defaults, and the triggers that keep every stored figure
// (task_count, spent/planned/subtask hours, subtask and milestone counts,
// closed, blocked) consistent whatever writes the rows. Idempotent.
//
// Every recompute function locks the row it rewrites before reading the
// sums, so its next statement's snapshot sees the concurrent writer that
// held the lock (READ COMMITTED) instead of overwriting its total.
func (m *projectModule) Migrate(ctx context.Context, db *orm.DB) error {
	for _, stmt := range migrations {
		if _, err := db.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("project: migrate: %w", err)
		}
	}
	return nil
}

// check adds a CHECK constraint once.
func check(table, name, expr string) string {
	return `DO $$ BEGIN ALTER TABLE ` + table + ` ADD CONSTRAINT ` + name + ` CHECK (` + expr + `);
	EXCEPTION WHEN duplicate_object THEN NULL; END $$`
}

// trigger (re)creates a row trigger; when is its optional WHEN condition.
func trigger(name, table, timing, when, fn string) []string {
	if when != "" {
		when = " WHEN (" + when + ")"
	}
	return []string{
		`DROP TRIGGER IF EXISTS ` + name + ` ON ` + table,
		`CREATE TRIGGER ` + name + ` ` + timing + ` ON ` + table + ` FOR EACH ROW` + when + ` EXECUTE FUNCTION ` + fn + `()`,
	}
}

var migrations = slices.Concat(
	[]string{
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_member_live ON project_member (project_id, user_id) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_user_live ON project_task_user (task_id, user_id) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_tag_live ON project_task_tag (task_id, tag_id) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_color_live ON project_task_color (task_id, color_id) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_dependency_live ON project_task_dependency (task_id, depends_on_id) WHERE deleted_at IS NULL`,
		`ALTER TABLE project ALTER COLUMN visibility SET DEFAULT 'everyone'`,
		`ALTER TABLE project ALTER COLUMN active SET DEFAULT true`,
		check("project", "project_visibility", "visibility IN ('everyone', 'members')"),
		check("project_timesheet", "project_timesheet_hours", "hours > 0"),

		// ── Recompute functions: each rewrites its row only when a figure changed.
		`CREATE OR REPLACE FUNCTION project_task_refresh(tid uuid) RETURNS void LANGUAGE plpgsql AS $$
		BEGIN
			IF tid IS NULL THEN RETURN; END IF;
			PERFORM 1 FROM project_task WHERE id = tid FOR UPDATE;
			UPDATE project_task t SET spent_hours = v.spent, subtask_hours = v.sub_hours,
				subtask_count = v.sub_count, subtask_done_count = v.sub_done
			FROM (SELECT
				COALESCE((SELECT sum(ts.hours) FROM project_timesheet ts WHERE ts.task_id = tid AND ts.deleted_at IS NULL), 0) AS spent,
				COALESCE((SELECT sum(c.spent_hours + c.subtask_hours) FROM project_task c WHERE c.parent_id = tid AND c.deleted_at IS NULL), 0) AS sub_hours,
				(SELECT count(*) FROM project_task c WHERE c.parent_id = tid AND c.deleted_at IS NULL)::int AS sub_count,
				(SELECT count(*) FROM project_task c WHERE c.parent_id = tid AND c.deleted_at IS NULL AND c.closed)::int AS sub_done) v
			WHERE t.id = tid AND (t.spent_hours, t.subtask_hours, t.subtask_count, t.subtask_done_count)
				IS DISTINCT FROM (v.spent, v.sub_hours, v.sub_count, v.sub_done);
		END $$`,
		`CREATE OR REPLACE FUNCTION project_task_refresh_blocked(tid uuid) RETURNS void LANGUAGE plpgsql AS $$
		BEGIN
			IF tid IS NULL THEN RETURN; END IF;
			PERFORM 1 FROM project_task WHERE id = tid FOR UPDATE;
			UPDATE project_task t SET blocked = v.b
			FROM (SELECT EXISTS (SELECT 1 FROM project_task_dependency d JOIN project_task b ON b.id = d.depends_on_id
				WHERE d.task_id = tid AND d.deleted_at IS NULL AND b.deleted_at IS NULL AND NOT b.closed) AS b) v
			WHERE t.id = tid AND t.blocked IS DISTINCT FROM v.b;
		END $$`,
		`CREATE OR REPLACE FUNCTION project_refresh(pid uuid) RETURNS void LANGUAGE plpgsql AS $$
		BEGIN
			IF pid IS NULL THEN RETURN; END IF;
			PERFORM 1 FROM project WHERE id = pid FOR UPDATE;
			UPDATE project p SET task_count = v.n, planned_hours = v.planned, spent_hours = v.spent
			FROM (SELECT
				(SELECT count(*) FROM project_task t WHERE t.project_id = pid AND t.deleted_at IS NULL)::int AS n,
				COALESCE((SELECT sum(t.planned_hours) FROM project_task t WHERE t.project_id = pid AND t.deleted_at IS NULL), 0) AS planned,
				COALESCE((SELECT sum(ts.hours) FROM project_timesheet ts JOIN project_task t ON t.id = ts.task_id
					WHERE ts.project_id = pid AND ts.deleted_at IS NULL AND t.deleted_at IS NULL), 0) AS spent) v
			WHERE p.id = pid AND (p.task_count, p.planned_hours, p.spent_hours) IS DISTINCT FROM (v.n, v.planned, v.spent);
		END $$`,
		`CREATE OR REPLACE FUNCTION project_milestone_refresh(mid uuid) RETURNS void LANGUAGE plpgsql AS $$
		BEGIN
			IF mid IS NULL THEN RETURN; END IF;
			PERFORM 1 FROM project_milestone WHERE id = mid FOR UPDATE;
			UPDATE project_milestone m SET task_count = v.n, task_done_count = v.done
			FROM (SELECT
				(SELECT count(*) FROM project_task t WHERE t.milestone_id = mid AND t.deleted_at IS NULL)::int AS n,
				(SELECT count(*) FROM project_task t WHERE t.milestone_id = mid AND t.deleted_at IS NULL AND t.closed)::int AS done) v
			WHERE m.id = mid AND (m.task_count, m.task_done_count) IS DISTINCT FROM (v.n, v.done);
		END $$`,

		// ── Trigger functions.
		`CREATE OR REPLACE FUNCTION project_default_stages() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			INSERT INTO project_stage (tenant_id, project_id, name, sequence, closed) VALUES
				(NEW.tenant_id, NEW.id, 'New', 10, false),
				(NEW.tenant_id, NEW.id, 'In progress', 20, false),
				(NEW.tenant_id, NEW.id, 'Done', 30, true);
			RETURN NULL;
		END $$`,
		`CREATE OR REPLACE FUNCTION project_task_mirror_closed() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			NEW.closed := COALESCE((SELECT s.closed FROM project_stage s WHERE s.id = NEW.stage_id), false);
			RETURN NEW;
		END $$`,
		// A parent cycle would otherwise recurse forever: fail the write rather
		// than store stale totals (ValidateTaskBody refuses cycles first).
		`CREATE OR REPLACE FUNCTION project_task_changed() RETURNS trigger LANGUAGE plpgsql AS $$
		DECLARE
			me uuid;
			dep uuid;
		BEGIN
			IF pg_trigger_depth() > 32 THEN RAISE EXCEPTION 'project: task cascade too deep (parent cycle?)'; END IF;
			IF TG_OP <> 'INSERT' THEN
				me := OLD.id;
				PERFORM project_task_refresh(OLD.parent_id);
				PERFORM project_milestone_refresh(OLD.milestone_id);
				PERFORM project_refresh(OLD.project_id);
			END IF;
			IF TG_OP <> 'DELETE' THEN
				me := NEW.id;
				PERFORM project_task_refresh(NEW.parent_id);
				PERFORM project_milestone_refresh(NEW.milestone_id);
				PERFORM project_refresh(NEW.project_id);
			END IF;
			FOR dep IN SELECT d.task_id FROM project_task_dependency d WHERE d.depends_on_id = me AND d.deleted_at IS NULL LOOP
				PERFORM project_task_refresh_blocked(dep);
			END LOOP;
			RETURN NULL;
		END $$`,
		`CREATE OR REPLACE FUNCTION project_timesheet_changed() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF TG_OP <> 'INSERT' THEN
				PERFORM project_task_refresh(OLD.task_id);
				PERFORM project_refresh(OLD.project_id);
			END IF;
			IF TG_OP <> 'DELETE' THEN
				PERFORM project_task_refresh(NEW.task_id);
				PERFORM project_refresh(NEW.project_id);
			END IF;
			RETURN NULL;
		END $$`,
		`CREATE OR REPLACE FUNCTION project_dependency_changed() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF TG_OP <> 'INSERT' THEN PERFORM project_task_refresh_blocked(OLD.task_id); END IF;
			IF TG_OP <> 'DELETE' THEN PERFORM project_task_refresh_blocked(NEW.task_id); END IF;
			RETURN NULL;
		END $$`,
		`CREATE OR REPLACE FUNCTION project_stage_closed_changed() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			UPDATE project_task SET closed = NEW.closed WHERE stage_id = NEW.id AND closed IS DISTINCT FROM NEW.closed;
			RETURN NULL;
		END $$`,

		// ── Order numbers (wbs_number "3.1.2"): sequence is a task's 1-based
		// position among its live siblings, wbs_number the dotted path of them.
		// project.ordering marks the order functions' own writes, which must not
		// re-enter them. One advisory lock per project serializes renumbering.
		`CREATE OR REPLACE FUNCTION project_task_order_lock(pid uuid) RETURNS void LANGUAGE sql AS $$
			SELECT pg_advisory_xact_lock(hashtext('project_task_order'), hashtext(pid::text)) $$`,
		// shortcut: rewrites the whole project's numbers per changed row, O(tasks)
		// each; move to a statement-level trigger if bulk task inserts get slow.
		`CREATE OR REPLACE FUNCTION project_task_renumber(pid uuid) RETURNS void LANGUAGE plpgsql AS $$
		BEGIN
			IF pid IS NULL THEN RETURN; END IF;
			PERFORM project_task_order_lock(pid);
			PERFORM set_config('project.ordering', 'on', true);
			WITH RECURSIVE ranked AS (
				SELECT id, parent_id, row_number() OVER (PARTITION BY parent_id ORDER BY sequence, created_at, id)::int AS rn
				FROM project_task WHERE project_id = pid AND deleted_at IS NULL),
			tree AS (
				SELECT id, rn::text AS code FROM ranked WHERE parent_id IS NULL
				UNION ALL SELECT r.id, tree.code || '.' || r.rn FROM ranked r JOIN tree ON r.parent_id = tree.id)
			UPDATE project_task t SET sequence = r.rn, wbs_number = tree.code
			FROM ranked r LEFT JOIN tree ON tree.id = r.id
			WHERE t.id = r.id AND (t.sequence, t.wbs_number) IS DISTINCT FROM (r.rn, tree.code);
			PERFORM set_config('project.ordering', 'off', true);
		END $$`,
		// BEFORE: puts the row at position sequence among its siblings (0 = last),
		// shifting the others; a re-parent sends 0 (validate.go), a moved
		// top-level task goes last in its new project, a moved subtask keeps its place.
		`CREATE OR REPLACE FUNCTION project_task_place() RETURNS trigger LANGUAGE plpgsql AS $$
		DECLARE
			k int;
			n int;
		BEGIN
			IF current_setting('project.ordering', true) = 'on' OR NEW.deleted_at IS NOT NULL THEN RETURN NEW; END IF;
			IF TG_OP = 'UPDATE' THEN
				IF (OLD.parent_id, OLD.sequence, OLD.deleted_at) IS NOT DISTINCT FROM (NEW.parent_id, NEW.sequence, NEW.deleted_at) THEN
					IF OLD.project_id = NEW.project_id OR NEW.parent_id IS NOT NULL THEN RETURN NEW; END IF;
					NEW.sequence := 0;
				END IF;
			END IF;
			PERFORM project_task_order_lock(NEW.project_id);
			k := CASE WHEN NEW.sequence > 0 THEN NEW.sequence ELSE 2147483647 END;
			PERFORM set_config('project.ordering', 'on', true);
			WITH s AS (
				SELECT id, row_number() OVER (ORDER BY sequence, created_at, id)::int AS rn FROM project_task
				WHERE project_id = NEW.project_id AND parent_id IS NOT DISTINCT FROM NEW.parent_id AND deleted_at IS NULL AND id <> NEW.id)
			UPDATE project_task t SET sequence = s.rn + (s.rn >= k)::int FROM s
			WHERE t.id = s.id AND t.sequence <> s.rn + (s.rn >= k)::int;
			PERFORM set_config('project.ordering', 'off', true);
			SELECT count(*) INTO n FROM project_task
			WHERE project_id = NEW.project_id AND parent_id IS NOT DISTINCT FROM NEW.parent_id AND deleted_at IS NULL AND id <> NEW.id;
			NEW.sequence := LEAST(k, n + 1);
			NEW.wbs_number := COALESCE((SELECT p.wbs_number || '.' FROM project_task p WHERE p.id = NEW.parent_id), '') || NEW.sequence;
			RETURN NEW;
		END $$`,
		// AFTER: siblings and descendants renumbered (also closes a deleted task's gap).
		`CREATE OR REPLACE FUNCTION project_task_order_changed() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN
			IF current_setting('project.ordering', true) = 'on' THEN RETURN NULL; END IF;
			IF TG_OP = 'INSERT' THEN
				PERFORM project_task_renumber(NEW.project_id);
				RETURN NULL;
			END IF;
			PERFORM project_task_renumber(OLD.project_id);
			IF TG_OP = 'UPDATE' THEN
				IF NEW.project_id <> OLD.project_id THEN PERFORM project_task_renumber(NEW.project_id); END IF;
			END IF;
			RETURN NULL;
		END $$`,
	},
	trigger("project_task_place", "project_task", "BEFORE INSERT OR UPDATE", "", "project_task_place"),
	trigger("project_task_order_ins_del", "project_task", "AFTER INSERT OR DELETE", "", "project_task_order_changed"),
	trigger("project_task_order_upd", "project_task", "AFTER UPDATE",
		`(OLD.parent_id, OLD.project_id, OLD.sequence, OLD.deleted_at) IS DISTINCT FROM (NEW.parent_id, NEW.project_id, NEW.sequence, NEW.deleted_at)`,
		"project_task_order_changed"),
	// Numbers existing tasks once (a no-op when they are already right).
	[]string{`SELECT project_task_renumber(id) FROM project`},
	trigger("project_default_stages", "project", "AFTER INSERT", "", "project_default_stages"),
	trigger("project_task_mirror_closed", "project_task", "BEFORE INSERT OR UPDATE OF stage_id", "", "project_task_mirror_closed"),
	trigger("project_task_ins_del", "project_task", "AFTER INSERT OR DELETE", "", "project_task_changed"),
	// blocked and the subtask counts are left out: they don't feed any other row.
	trigger("project_task_upd", "project_task", "AFTER UPDATE",
		`(OLD.stage_id, OLD.parent_id, OLD.milestone_id, OLD.project_id, OLD.planned_hours, OLD.deleted_at, OLD.closed, OLD.spent_hours, OLD.subtask_hours)`+
			` IS DISTINCT FROM (NEW.stage_id, NEW.parent_id, NEW.milestone_id, NEW.project_id, NEW.planned_hours, NEW.deleted_at, NEW.closed, NEW.spent_hours, NEW.subtask_hours)`,
		"project_task_changed"),
	trigger("project_timesheet_ins_del", "project_timesheet", "AFTER INSERT OR DELETE", "", "project_timesheet_changed"),
	trigger("project_timesheet_upd", "project_timesheet", "AFTER UPDATE",
		`(OLD.task_id, OLD.project_id, OLD.hours, OLD.deleted_at) IS DISTINCT FROM (NEW.task_id, NEW.project_id, NEW.hours, NEW.deleted_at)`,
		"project_timesheet_changed"),
	trigger("project_dependency_ins_del", "project_task_dependency", "AFTER INSERT OR DELETE", "", "project_dependency_changed"),
	trigger("project_dependency_upd", "project_task_dependency", "AFTER UPDATE",
		`(OLD.task_id, OLD.depends_on_id, OLD.deleted_at) IS DISTINCT FROM (NEW.task_id, NEW.depends_on_id, NEW.deleted_at)`,
		"project_dependency_changed"),
	trigger("project_stage_closed", "project_stage", "AFTER UPDATE OF closed", "OLD.closed IS DISTINCT FROM NEW.closed", "project_stage_closed_changed"),
)
