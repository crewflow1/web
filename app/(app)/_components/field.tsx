/**
 * Reusable form field — extracted from the onboarding/company pattern so
 * jobs and customers forms have the same look + behaviour.
 *
 * Server/client-safe (no client hooks). Pair with React 19
 * `useActionState` upstream: pass `defaultValue` from the action's
 * echoed `state.values` so input survives validation failures, and
 * `error` from `state.fieldErrors[name]` so messages render inline.
 */

import type { InputHTMLAttributes } from "react";

type Props = {
  name: string;
  label: string;
  type?: InputHTMLAttributes<HTMLInputElement>["type"];
  required?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
  autoComplete?: string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
  error?: string;
};

export function Field({
  name,
  label,
  type = "text",
  required = false,
  optional = false,
  placeholder,
  help,
  defaultValue,
  autoComplete,
  inputMode,
  error,
}: Props) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label
        htmlFor={name}
        className="flex items-baseline justify-between text-sm font-medium text-slate-800"
      >
        <span>
          {label}
          {required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </span>
        {optional ? (
          <span className="text-xs text-slate-400">Optional</span>
        ) : null}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        // Select-on-focus for numeric fields so a prefilled value (e.g. an
        // edited lead's estimated value) is replaced rather than appended to
        // — the H1 "21600.00"→"21600.0010000" defect. Left undefined for
        // text/select types so this component stays server-renderable (no
        // event handler is attached unless the field is numeric, and numeric
        // Fields are only ever rendered inside client components).
        onFocus={type === "number" ? (e) => e.currentTarget.select() : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={`mt-1.5 block w-full rounded-md border px-3 py-2.5 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-1 ${
          error
            ? "border-red-400 focus:border-red-500 focus:ring-red-500"
            : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
        }`}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : help ? (
        <p className="mt-1 text-xs text-slate-500">{help}</p>
      ) : null}
    </div>
  );
}

type TextareaProps = {
  name: string;
  label: string;
  rows?: number;
  required?: boolean;
  optional?: boolean;
  placeholder?: string;
  help?: string;
  defaultValue?: string;
  error?: string;
};

export function TextareaField({
  name,
  label,
  rows = 4,
  required = false,
  optional = false,
  placeholder,
  help,
  defaultValue,
  error,
}: TextareaProps) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label
        htmlFor={name}
        className="flex items-baseline justify-between text-sm font-medium text-slate-800"
      >
        <span>
          {label}
          {required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </span>
        {optional ? (
          <span className="text-xs text-slate-400">Optional</span>
        ) : null}
      </label>
      <textarea
        id={name}
        name={name}
        rows={rows}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={`mt-1.5 block w-full rounded-md border px-3 py-2.5 text-sm placeholder:text-slate-400 focus:outline-none focus:ring-1 ${
          error
            ? "border-red-400 focus:border-red-500 focus:ring-red-500"
            : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
        }`}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : help ? (
        <p className="mt-1 text-xs text-slate-500">{help}</p>
      ) : null}
    </div>
  );
}

type SelectProps = {
  name: string;
  label: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  required?: boolean;
  help?: string;
  error?: string;
};

export function SelectField({
  name,
  label,
  options,
  defaultValue,
  required = false,
  help,
  error,
}: SelectProps) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div>
      <label
        htmlFor={name}
        className="block text-sm font-medium text-slate-800"
      >
        {label}
        {required ? <span className="ml-0.5 text-red-500">*</span> : null}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={`mt-1.5 block w-full rounded-md border bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-1 ${
          error
            ? "border-red-400 focus:border-red-500 focus:ring-red-500"
            : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
        }`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : help ? (
        <p className="mt-1 text-xs text-slate-500">{help}</p>
      ) : null}
    </div>
  );
}
