import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/** A text label with a semantic tone. The text always carries the meaning. */
export const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold",
  {
    variants: {
      tone: {
        neutral: "bg-neutral-bg text-neutral-fg",
        info: "bg-info-bg text-info-fg",
        warning: "bg-warning-bg text-warning-fg",
        blocked: "bg-blocked-bg text-blocked-fg",
        verified: "bg-verified-bg text-verified-fg",
        suggested: "bg-suggested-bg text-suggested-fg",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type Tone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
