import { forwardRef } from "react";
import Link from "next/link";

/**
 * Single source of truth for buttons.
 *
 *   Variants: primary | secondary | ghost | destructive
 *   Sizes:    sm | md | lg
 *
 * Use `<Button>` for native <button> + form submissions.
 * Use `<ButtonLink>` when the affordance is navigation.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-semibold shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-slate-900 text-white hover:bg-slate-800",
  secondary:
    "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 shadow-none",
  ghost: "bg-transparent text-slate-700 hover:bg-slate-100 shadow-none",
  destructive:
    "border border-red-300 bg-white text-red-700 hover:bg-red-50 shadow-none",
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
  return [BASE, VARIANT[variant], SIZE[size], extra ?? ""]
    .filter(Boolean)
    .join(" ")
    .trim();
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
