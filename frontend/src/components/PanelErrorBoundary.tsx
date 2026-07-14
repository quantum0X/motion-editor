import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
  label: string;
}

interface State {
  error: Error | null;
}

/**
 * A panel-scoped error boundary, so a crash in (say) the timeline
 * doesn't take the whole editor - including the still-working
 * preview - down with it. See ErrorBoundary.tsx for the full
 * explanation of why boundaries matter here at all.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error(`Unhandled error in ${this.props.label}:`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-surface-1 text-text-secondary p-4 text-center">
        <AlertTriangle size={18} className="text-danger" />
        <p className="text-xs">
          The {this.props.label} panel hit an error and stopped rendering.
        </p>
        <button
          onClick={() => this.setState({ error: null })}
          className="text-xs px-2.5 py-1 rounded-md bg-surface-3 hover:bg-border-strong text-text-primary transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }
}
