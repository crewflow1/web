import { Plus } from "lucide-react";
import {
  AI_EMPLOYEE_STATUSES,
  STATUS_LABELS,
  MEMORY_SCOPES,
  MEMORY_SCOPE_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type AiEmployee,
} from "@/lib/ai-employees/model";
import { Alert, Button, Field, Input, Select, Textarea } from "@/components/ui";
import {
  updateAiEmployeeConfig,
  addAiEmployeeTask,
  addAiEmployeeMemory,
} from "./actions";

/**
 * AI Employees — operator write forms (CEO Directive 007.5 consolidation).
 *
 * The three forms the old AI Boardroom owned — configuration, task-logging and
 * memory-append — rebuilt on the design-system form primitives and embedded in
 * the Employee SDK profile. Server components: each is a thin <form> wired to a
 * server action; no client JS. They render only for a seeded employee (a live
 * `ai_employees` row), so every field pre-fills from real data.
 *
 * SAFE FIELDS ONLY. There is no execution toggle anywhere here — `can_execute`
 * is never submitted, mirroring the actions that back these forms.
 */

/** A success / error banner driven by the `?saved=` / `?error=` query. */
export function SavedBanner({
  saved,
  error,
}: {
  saved?: string;
  error?: string;
}) {
  if (error) {
    return <Alert tone="danger">{decodeURIComponent(error)}</Alert>;
  }
  if (saved) {
    return <Alert tone="success">{prettySaved(saved)}</Alert>;
  }
  return null;
}

function prettySaved(saved: string): string {
  switch (saved) {
    case "config":
      return "Configuration saved.";
    case "task":
      return "Task logged.";
    case "memory":
      return "Memory entry added.";
    default:
      return "Saved.";
  }
}

// ---------------------------------------------------------------------
// Configuration — safe descriptive fields only (audit-logged)
// ---------------------------------------------------------------------

export function ConfigForm({ row }: { row: AiEmployee }) {
  return (
    <form action={updateAiEmployeeConfig} className="space-y-4">
      <input type="hidden" name="id" value={row.id} />
      <input type="hidden" name="slug" value={row.slug} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Status" htmlFor="cfg-status">
          <Select id="cfg-status" name="status" defaultValue={row.status}>
            {AI_EMPLOYEE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Memory scope" htmlFor="cfg-memory_scope">
          <Select
            id="cfg-memory_scope"
            name="memory_scope"
            defaultValue={row.memory_scope}
          >
            {MEMORY_SCOPES.map((s) => (
              <option key={s} value={s}>
                {MEMORY_SCOPE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Planned provider" htmlFor="cfg-model_provider">
          <Input
            id="cfg-model_provider"
            name="model_provider"
            type="text"
            maxLength={60}
            defaultValue={row.model_provider ?? ""}
            placeholder="e.g. anthropic"
          />
        </Field>
        <Field label="Planned model" htmlFor="cfg-model_name">
          <Input
            id="cfg-model_name"
            name="model_name"
            type="text"
            maxLength={120}
            defaultValue={row.model_name ?? ""}
            placeholder="e.g. claude-opus-4-7"
          />
        </Field>
      </div>
      <Field label="Role" htmlFor="cfg-role">
        <Input
          id="cfg-role"
          name="role"
          type="text"
          maxLength={200}
          defaultValue={row.role}
        />
      </Field>
      <Field label="Current task" hint="optional" htmlFor="cfg-current_task">
        <Input
          id="cfg-current_task"
          name="current_task"
          type="text"
          maxLength={500}
          defaultValue={row.current_task ?? ""}
          placeholder="What is this employee focused on right now?"
        />
      </Field>
      <Field label="Description" hint="optional" htmlFor="cfg-description">
        <Textarea
          id="cfg-description"
          name="description"
          rows={2}
          maxLength={4000}
          defaultValue={row.description}
        />
      </Field>
      <Field
        label="System prompt"
        hint="defines the role; not yet sent to any model"
        htmlFor="cfg-system_prompt"
      >
        <Textarea
          id="cfg-system_prompt"
          name="system_prompt"
          rows={6}
          maxLength={20_000}
          defaultValue={row.system_prompt}
          className="font-mono text-xs leading-relaxed"
        />
      </Field>
      <Button type="submit" variant="accent">
        Save configuration
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------
// Log a task-history entry (manual, descriptive — no execution)
// ---------------------------------------------------------------------

export function LogTaskForm({ row }: { row: AiEmployee }) {
  return (
    <form
      action={addAiEmployeeTask}
      className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800"
    >
      <input type="hidden" name="ai_employee_id" value={row.id} />
      <input type="hidden" name="slug" value={row.slug} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Field label="New task title" htmlFor="task-title">
            <Input
              id="task-title"
              name="title"
              type="text"
              required
              maxLength={300}
              placeholder="e.g. Draft Q3 outbound sequence"
            />
          </Field>
        </div>
        <Field label="Status" htmlFor="task-status">
          <Select id="task-status" name="status" defaultValue="pending">
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Summary" hint="optional" htmlFor="task-summary">
        <Textarea id="task-summary" name="summary" rows={2} maxLength={8000} />
      </Field>
      <Button type="submit" variant="glass" size="sm">
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Log task
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------
// Append a memory entry (manual, descriptive)
// ---------------------------------------------------------------------

export function AddMemoryForm({ row }: { row: AiEmployee }) {
  return (
    <form
      action={addAiEmployeeMemory}
      className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800"
    >
      <input type="hidden" name="ai_employee_id" value={row.id} />
      <input type="hidden" name="slug" value={row.slug} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Key" hint="optional" htmlFor="mem-mem_key">
          <Input
            id="mem-mem_key"
            name="mem_key"
            type="text"
            maxLength={200}
            placeholder="e.g. tone_of_voice"
          />
        </Field>
        <Field label="Scope" htmlFor="mem-scope">
          <Select id="mem-scope" name="scope" defaultValue={row.memory_scope}>
            {MEMORY_SCOPES.map((s) => (
              <option key={s} value={s}>
                {MEMORY_SCOPE_LABELS[s]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Content" htmlFor="mem-content">
        <Textarea
          id="mem-content"
          name="content"
          rows={3}
          required
          maxLength={20_000}
          placeholder="A fact or instruction this employee should remember."
        />
      </Field>
      <Button type="submit" variant="glass" size="sm">
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add memory
      </Button>
    </form>
  );
}
