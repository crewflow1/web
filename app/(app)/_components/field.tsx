/**
 * Reusable form field — extracted from the onboarding/company pattern so
 * jobs and customers forms have the same look + behaviour.
 *
 * Server-rendered; no client state. For interactive validation, wrap in a
 * client component upstream.
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
}: Props) {
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
        className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      {help ? <p className="mt-1 text-xs text-slate-500">{help}</p> : null}
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
}: TextareaProps) {
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
        className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      {help ? <p className="mt-1 text-xs text-slate-500">{help}</p> : null}
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
};

export function SelectField({
  name,
  label,
  options,
  defaultValue,
  required = false,
  help,
}: SelectProps) {
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
        className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {help ? <p className="mt-1 text-xs text-slate-500">{help}</p> : null}
    </div>
  );
}
