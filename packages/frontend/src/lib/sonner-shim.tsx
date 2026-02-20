import { XIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

type ToastKind = "default" | "success" | "error" | "info" | "warning" | "loading";

type ToastEntry = {
  id: number;
  kind: ToastKind;
  message: ReactNode;
  description?: ReactNode;
  duration: number;
};

type ToastInput = {
  description?: ReactNode;
  duration?: number;
};

export type ToasterProps = {
  className?: string;
  closeButton?: boolean;
  theme?: "light" | "dark" | "system" | (string & {});
  richColors?: boolean;
  duration?: number;
  icons?: Partial<Record<ToastKind, ReactNode>>;
  style?: CSSProperties;
  toastOptions?: {
    classNames?: {
      toast?: string;
      description?: string;
      actionButton?: string;
      cancelButton?: string;
    };
  };
};

type Listener = (toasts: ToastEntry[]) => void;

const listeners = new Set<Listener>();
let toastState: ToastEntry[] = [];
let toastId = 1;

function notifyListeners() {
  for (const listener of listeners) {
    listener(toastState);
  }
}

function dismiss(id: number) {
  toastState = toastState.filter((toastItem) => toastItem.id !== id);
  notifyListeners();
}

function enqueue(kind: ToastKind, message: ReactNode, input?: ToastInput): number {
  const id = toastId++;
  const duration = input?.duration ?? 4000;

  toastState = [
    ...toastState,
    {
      id,
      kind,
      message,
      description: input?.description,
      duration,
    },
  ];

  notifyListeners();

  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }

  return id;
}

type ToastFn = ((message: ReactNode, input?: ToastInput) => number) & {
  success: (message: ReactNode, input?: ToastInput) => number;
  error: (message: ReactNode, input?: ToastInput) => number;
  info: (message: ReactNode, input?: ToastInput) => number;
  warning: (message: ReactNode, input?: ToastInput) => number;
  loading: (message: ReactNode, input?: ToastInput) => number;
  dismiss: (id?: number) => void;
};

const baseToast = (message: ReactNode, input?: ToastInput) => enqueue("default", message, input);

export const toast = Object.assign(baseToast, {
  success: (message: ReactNode, input?: ToastInput) => enqueue("success", message, input),
  error: (message: ReactNode, input?: ToastInput) => enqueue("error", message, input),
  info: (message: ReactNode, input?: ToastInput) => enqueue("info", message, input),
  warning: (message: ReactNode, input?: ToastInput) => enqueue("warning", message, input),
  loading: (message: ReactNode, input?: ToastInput) => enqueue("loading", message, input),
  dismiss: (id?: number) => {
    if (typeof id === "number") {
      dismiss(id);
      return;
    }
    toastState = [];
    notifyListeners();
  },
}) as ToastFn;

const kindStyles: Record<ToastKind, string> = {
  default: "border-border bg-card text-card-foreground",
  success: "border-success/30 bg-success/10 text-success",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  info: "border-info/30 bg-info/10 text-info",
  warning: "border-warning/30 bg-warning/10 text-warning",
  loading: "border-border bg-card text-card-foreground",
};

export function Toaster({ className, closeButton, icons, style, toastOptions }: ToasterProps) {
  const [items, setItems] = useState<ToastEntry[]>(toastState);

  useEffect(() => {
    const listener: Listener = (nextState) => setItems(nextState);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return (
    <div className={className} style={style}>
      <div className="pointer-events-none fixed top-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2 px-4 sm:px-0">
        {items.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto rounded-lg border p-3 shadow-md ${kindStyles[item.kind]} ${toastOptions?.classNames?.toast ?? ""}`}
          >
            <div className="flex items-start gap-2">
              {icons?.[item.kind] ? (
                <span className="mt-0.5 shrink-0">{icons[item.kind]}</span>
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{item.message}</p>
                {item.description ? (
                  <p
                    className={`mt-1 text-xs text-muted-foreground ${toastOptions?.classNames?.description ?? ""}`}
                  >
                    {item.description}
                  </p>
                ) : null}
              </div>
              {closeButton ? (
                <button
                  type="button"
                  onClick={() => dismiss(item.id)}
                  className="inline-flex size-5 items-center justify-center rounded transition-colors hover:bg-black/10"
                >
                  <XIcon className="size-3" />
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
