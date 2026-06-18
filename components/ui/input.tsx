import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Form primitives for the dark HQ surfaces — Input, Textarea, Select, Label and
 * a Field wrapper that pairs a label, an optional leading icon and an inline
 * error. Class strings are lifted from the live Research launcher so forms look
 * identical everywhere.
 */

const CONTROL =
  "w-full rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2.5 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-60";

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(CONTROL, className)} {...rest} />;
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(CONTROL, "min-h-[96px] resize-y", className)}
      {...rest}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(CONTROL, "pr-8", className)} {...rest}>
      {children}
    </select>
  );
});

export function Label({
  className,
  children,
  ...rest
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1 block text-xs font-medium text-slate-400", className)}
      {...rest}
    >
      {children}
    </label>
  );
}

/** A labelled field: label, optional leading icon, control slot and error. */
export function Field({
  label,
  hint,
  error,
  icon,
  htmlFor,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  icon?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("block", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {hint ? <span className="ml-1 text-slate-600">{hint}</span> : null}
      </Label>
      <div className="relative">
        {icon ? (
          <span
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 [&>svg]:h-4 [&>svg]:w-4"
            aria-hidden
          >
            {icon}
          </span>
        ) : null}
        <div className={icon ? "[&_input]:pl-9 [&_select]:pl-9" : undefined}>
          {children}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
