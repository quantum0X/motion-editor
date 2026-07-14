import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary.
 *
 * Why this exists: this app previously had NO error boundary anywhere.
 * React's default behavior when a component throws during render (with
 * no boundary above it) is to unmount the *entire* tree, leaving
 * whatever the page background is - here, `#0d0d10` from index.css -
 * showing through. That is exactly what a "black screen after clicking
 * X" bug report looks like from the outside, for any uncaught exception
 * anywhere in the tree, not just one specific feature. Wrapping the app
 * in a boundary turns every one of those crashes into a recoverable
 * "Something went wrong" panel with a reload button instead of a dead
 * black window, and this file's job is to be a robust fallback - not
 * a substitute for fixing the underlying bugs that throw in the first
 * place.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("Unhandled error in component tree:", error, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  private handleDismiss = () => {
    // Best-effort recovery without a full reload - works when the crash
    // was transient/state-related rather than a hard structural bug.
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface-0 text-text-primary p-6">
        <div className="max-w-md w-full bg-surface-1 border border-border-subtle rounded-lg p-6 space-y-4">
          <div className="flex items-center gap-2 text-danger">
            <AlertTriangle size={20} />
            <h1 className="text-base font-semibold">Something went wrong</h1>
          </div>
          <p className="text-sm text-text-secondary">
            A part of the editor hit an unexpected error and had to stop. Your project data on disk is unaffected -
            reloading will bring the editor back.
          </p>
          <pre className="text-xs text-text-tertiary bg-surface-0 rounded p-2 overflow-auto max-h-32 whitespace-pre-wrap break-words">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={this.handleReload}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-accent hover:bg-accent-dim text-white transition-colors"
            >
              <RotateCcw size={13} />
              Reload editor
            </button>
            <button
              onClick={this.handleDismiss}
              className="text-xs px-3 py-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
            >
              Try to continue
            </button>
          </div>
        </div>
      </div>
    );
  }
}
