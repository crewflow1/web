"use client";

/**
 * A submit button that requires an explicit confirm() before the form posts.
 * Used to gate the high-consequence operator commit/rollback actions.
 */
export function ConfirmButton({
  children,
  confirmText,
  className,
}: {
  children: React.ReactNode;
  confirmText: string;
  className?: string;
}) {
  return (
    <button
      type="submit"
      className={className}
      onClick={(e) => {
        if (!window.confirm(confirmText)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
