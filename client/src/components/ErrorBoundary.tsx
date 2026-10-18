import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Without this, any render-time exception unmounts the whole React tree and the user sees a blank
 * page. This shows what went wrong and offers a clean restart (clears the saved room session).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI crashed:', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 720, margin: '10vh auto', color: '#f4efe6', font: '15px/1.5 system-ui, sans-serif' }}>
        <h2 style={{ marginTop: 0 }}>Something went wrong</h2>
        <p>The page hit an error. Press the button to start fresh. If it keeps happening, send a screenshot of this box.</p>
        <pre style={{ whiteSpace: 'pre-wrap', background: '#1a1714', padding: 12, borderRadius: 8, fontSize: 13 }}>
          {error.name}: {error.message}
          {'\n'}
          {(error.stack ?? '').split('\n').slice(1, 6).join('\n')}
        </pre>
        <button
          style={{ padding: '10px 18px', fontSize: 15, cursor: 'pointer' }}
          onClick={() => {
            try {
              sessionStorage.clear();
            } catch {
              /* ignore */
            }
            location.assign('/');
          }}
        >
          Start fresh
        </button>
      </div>
    );
  }
}
