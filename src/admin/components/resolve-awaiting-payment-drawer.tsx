import {
  Alert,
  Button,
  Drawer,
  Label,
  Text,
  Textarea,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { useMutation } from "@tanstack/react-query"
import { ReactNode, useEffect, useState } from "react"
import { sdk } from "../lib/client"
import { getAdminErrorMessage } from "../lib/admin-error-message"

type ResolveAwaitingPaymentDrawerProps<TResponse> = {
  open: boolean
  onOpenChange: (open: boolean) => void
  endpoint: string
  explanation: ReactNode
  onResolved: (response: TResponse) => void | Promise<void>
}

export function ResolveAwaitingPaymentDrawer<TResponse>({
  open,
  onOpenChange,
  endpoint,
  explanation,
  onResolved,
}: ResolveAwaitingPaymentDrawerProps<TResponse>) {
  const prompt = usePrompt()
  const [reason, setReason] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setReason("")
      setError(null)
    }
  }, [open])

  const resolveMutation = useMutation({
    mutationFn: async (body: { reason?: string }) =>
      sdk.client.fetch<TResponse>(endpoint, {
        method: "POST",
        body,
      }),
    onSuccess: async (response) => {
      await onResolved(response)
      onOpenChange(false)
    },
    onError: (mutationError) => {
      const message = getAdminErrorMessage(
        mutationError,
        "Failed to resolve the payment"
      )

      setError(message)
      toast.error(message)
    },
  })

  const handleSubmit = async () => {
    setError(null)

    const confirmed = await prompt({
      title: "Resolve payment?",
      description:
        "The outcome depends on whether the order has been paid and can't be undone.",
      confirmText: "Resolve payment",
      cancelText: "Cancel",
    })

    if (!confirmed) {
      return
    }

    const trimmed = reason.trim()

    await resolveMutation.mutateAsync(trimmed ? { reason: trimmed } : {})
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <Drawer.Content>
        <Drawer.Header>
          <Drawer.Title>Resolve payment</Drawer.Title>
        </Drawer.Header>
        <Drawer.Body className="flex flex-1 flex-col gap-y-4 p-4">
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {explanation}
          </Text>
          <div className="flex flex-col gap-y-2">
            <Label htmlFor="resolve-awaiting-payment-reason">Reason</Label>
            <Textarea
              id="resolve-awaiting-payment-reason"
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional note, e.g. what the payment provider confirmed"
            />
          </div>
        </Drawer.Body>
        <Drawer.Footer>
          <div className="flex items-center justify-end gap-x-2">
            <Drawer.Close asChild>
              <Button
                size="small"
                variant="secondary"
                type="button"
                disabled={resolveMutation.isPending}
              >
                Cancel
              </Button>
            </Drawer.Close>
            <Button
              size="small"
              type="button"
              isLoading={resolveMutation.isPending}
              disabled={resolveMutation.isPending}
              onClick={() => {
                void handleSubmit().catch(() => undefined)
              }}
            >
              Resolve payment
            </Button>
          </div>
        </Drawer.Footer>
      </Drawer.Content>
    </Drawer>
  )
}
