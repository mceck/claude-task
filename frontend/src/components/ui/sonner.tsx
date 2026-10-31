"use client"

import { useTheme } from "@/lib/theme"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * Sonner dismisses a toast only through its close button or a swipe. A click anywhere on the
 * toast should dismiss it too, so the click is forwarded to that toast's close button (the
 * same path, so the dismissal animation and `onDismiss` still run).
 */
const dismissClickedToast = (event: React.MouseEvent<HTMLDivElement>) => {
  const target = event.target
  if (!(target instanceof Element) || target.closest("button, a, input, select, textarea")) return
  const toast = target.closest("[data-sonner-toast]")
  toast?.querySelector<HTMLButtonElement>("[data-close-button]")?.click()
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme: theme } = useTheme()

  return (
    <div onClick={dismissClickedToast}>
      <Sonner
        theme={theme as ToasterProps["theme"]}
        className="toaster group"
        closeButton
        icons={{
          success: (
            <CircleCheckIcon className="size-4" />
          ),
          info: (
            <InfoIcon className="size-4" />
          ),
          warning: (
            <TriangleAlertIcon className="size-4" />
          ),
          error: (
            <OctagonXIcon className="size-4" />
          ),
          loading: (
            <Loader2Icon className="size-4 animate-spin" />
          ),
        }}
        style={
          {
            "--normal-bg": "var(--popover)",
            "--normal-text": "var(--popover-foreground)",
            "--normal-border": "var(--border)",
            "--border-radius": "var(--radius)",
            // The close button sits on the right corner instead of sonner's default left one.
            "--toast-close-button-start": "unset",
            "--toast-close-button-end": "0",
            "--toast-close-button-transform": "translate(35%, -35%)",
          } as React.CSSProperties
        }
        toastOptions={{
          classNames: {
            toast: "cn-toast cursor-pointer",
          },
        }}
        {...props}
      />
    </div>
  )
}

export { Toaster }
