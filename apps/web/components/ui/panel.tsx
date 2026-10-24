import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

/** A titled region of the workbench. The heading names the region for assistive technology. */
export function Panel({
  id,
  title,
  description,
  actions,
  className,
  children,
  level = 2,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className={cn("rounded-[var(--radius-panel)] border border-border bg-surface", className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <Heading id={`${id}-heading`} className="text-base font-semibold">
            {title}
          </Heading>
          {description !== undefined && <p className="text-sm text-muted">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Notice({
  tone = "info",
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: "info" | "warning" | "blocked" | "verified" }) {
  const tones = {
    info: "border-info-fg/30 bg-info-bg text-info-fg",
    warning: "border-warning-fg/30 bg-warning-bg text-warning-fg",
    blocked: "border-blocked-fg/30 bg-blocked-bg text-blocked-fg",
    verified: "border-verified-fg/30 bg-verified-bg text-verified-fg",
  };
  return (
    <div
      className={cn(
        "rounded-[var(--radius-control)] border px-4 py-3 text-sm",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
