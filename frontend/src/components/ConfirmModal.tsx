'use client'

import { AlertTriangle, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface ConfirmModalProps {
  isOpen: boolean
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  isDestructive?: boolean
  isLoading?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDestructive = false,
  isLoading = false,
  onConfirm,
  onClose
}: ConfirmModalProps) {
  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-5 shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-2">
            {isDestructive && <AlertTriangle className="w-4 h-4 text-red-500" />}
            {title}
          </h2>
          <button
            onClick={onClose}
            disabled={isLoading}
            className="rounded-full p-1 hover:bg-accent text-muted-foreground transition-colors disabled:opacity-30"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed mb-6">
          {message}
        </p>

        <div className="flex gap-2">
          <button
            onClick={onClose}
            disabled={isLoading}
            className="flex-1 px-3 py-2 rounded-md border border-border bg-background text-xs font-medium hover:bg-accent transition-colors disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            className={cn(
              "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-semibold text-white transition-colors disabled:opacity-50",
              isDestructive ? "bg-red-600 hover:bg-red-700" : "bg-primary hover:bg-primary/90"
            )}
          >
            {isLoading && <Loader2 className="w-3 h-3 animate-spin" />}
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
