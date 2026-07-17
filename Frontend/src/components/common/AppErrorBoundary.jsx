import React from 'react';
import { isStaleChunkError, reloadOnceForStaleChunk } from '../../utils/chunkReload';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Application render error:', error, errorInfo);
    // Stale-deploy chunk failure (old hashed asset gone after a new release):
    // a reload always fixes it, so do it automatically — once. If it happens
    // again right away the guard refuses and the fallback UI below shows.
    if (isStaleChunkError(error)) {
      reloadOnceForStaleChunk();
    }
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="min-h-screen flex items-center justify-center p-6" style={{ background: 'hsl(var(--background))', color: 'hsl(var(--foreground))' }}>
        <section className="w-full max-w-md rounded-2xl p-6 text-center" style={{ background: 'var(--glass-bg-strong)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow-soft)' }}>
          <h1 className="text-2xl font-bold mb-3">Something went wrong</h1>
          <p className="text-sm mb-5" style={{ color: 'hsl(var(--muted-foreground))' }}>
            The page hit a temporary problem. You can try again without losing your session.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button
              type="button"
              onClick={this.handleRetry}
              className="px-4 py-2 rounded-xl font-semibold"
              style={{ background: 'var(--logo-gradient)', color: 'white' }}
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-xl font-semibold"
              style={{ background: 'hsl(var(--muted))', color: 'hsl(var(--foreground))' }}
            >
              Reload page
            </button>
          </div>
        </section>
      </main>
    );
  }
}

export default AppErrorBoundary;

