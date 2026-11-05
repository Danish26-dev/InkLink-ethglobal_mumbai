import { Component, ReactNode } from 'react';

/**
 * Catches runtime errors inside the WebGL subtree (context loss, shader
 * failure) and renders a static fallback so the page stays fully usable.
 */
export default class CanvasBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('INKLINK 3D layer disabled:', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
