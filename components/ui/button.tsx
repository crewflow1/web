import { forwardRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Single source of truth for buttons.
 *
 *   Light surfaces:  primary | secondary | ghost | destructive
 *   Dark HQ surfaces: accent | glass | subtle
 *   Sizes:           sm | md | lg
 *
 * Use `<Button>` for native <button> + form submissions.
 * Use `<ButtonLink>` when the affordance is navigation (renders Next <Link>).
 *
 * The dark variants are the HQ standard — `accent` is the indigo primary lifted
 * from the live Research launcher. They override the base focus ring via
 * tailwind-merge so the focus state reads correctly on a dark canvas.
 */

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "destructive"
  | "accent"
  | "glass"
  | "subtle";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";

const VARIANT: Record<ButtonVariant, string> = {
  // Light surfaces (the customer product, marketing).
  primary: "bg-slate-900 text-white hover:bg-slate-800",
  secondary:
    "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-none",
  ghost: "bg-transparent text-slate-700 hover:bg-slate-100 shadow-none",
  destructive:
    "border border-red-300 bg-white text-red-700 hover:bg-red-50 shadow-none",
  // Dark HQ surfaces.
  accent:
    "bg-indigo-600 text-white shadow-lg shadow-indigo-900/30 hover:bg-indigo-500 focus-visible:ring-indigo-500/50 focus-visible:ring-offset-slate-950",
  glass:
    "border border-slate-700 bg-slate-900 text-slate-200 shadow-none hover:bg-slate-800 focus-visible:ring-slate-500 focus-visible:ring-offset-slate-950",
  subtle:
    "bg-slate-800/70 text-slate-200 shadow-none hover:bg-slate-800 focus-visible:ring-slate-500 focus-visible:ring-offset-slate-950",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
};

export function buttonClass(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  extra?: string,
): string {
  return cn(BASE, VARIANT[variant], SIZE[size], extra);
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, className)}
      {...rest}
    />
  );
});

type ButtonLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  external?: boolean;
};

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  external,
  ...rest
}: ButtonLinkProps) {
  const cls = buttonClass(variant, size, className);
  if (external) {
    return <a href={href} className={cls} {...rest} />;
  }
  return <Link href={href} className={cls} {...rest} />;
}
