/**
 * Cooperative cancellation for in-flight fetches.
 *
 * @module
 */

/**
 * Thrown by a data source that notices its fetch was cancelled.
 *
 * The grid swallows it: a cancelled request has no answer to show and is not
 * a failure the user should see. Anything else a source throws becomes
 * `GridController.error`.
 */
export class FetchCancelled extends Error {
  /** Why the fetch was cancelled, if the caller said. */
  readonly reason: string | null;

  constructor(reason?: string | null) {
    super(
      reason === null || reason === undefined
        ? 'FetchCancelled'
        : `FetchCancelled: ${reason}`,
    );
    this.name = 'FetchCancelled';
    this.reason = reason ?? null;
  }
}

/**
 * Tells a data source that the grid no longer wants the answer.
 *
 * The grid already drops a stale response, so a result that arrives late can
 * never overwrite a newer one — but dropping it is not the same as not paying
 * for it. Every keystroke in a filter row starts a request that runs to
 * completion on the server, holds a connection and burns quota. A source that
 * is handed one of these can abort instead: pass {@link abortSignal} straight
 * to `fetch`, register {@link onCancel} to close a socket, or call
 * {@link throwIfCancelled} between the stages of a long local computation.
 *
 * Cancellation is cooperative. A source that ignores the signal is still
 * correct, just wasteful.
 */
export class FetchSignal {
  private cancelled = false;
  private reasonValue: string | null = null;
  private listeners: (() => void)[] | null = null;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private resolvePending: (() => void) | null = null;

  /** Whether the grid has given up on this fetch. */
  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Why, if a reason was given. */
  get reason(): string | null {
    return this.reasonValue;
  }

  /**
   * The same cancellation as a standard `AbortSignal`, to hand to `fetch` or
   * anything else that takes one.
   *
   * Built on first use, so a source that never aborts pays nothing for it.
   */
  get abortSignal(): AbortSignal {
    if (this.controller === null) {
      this.controller = new AbortController();
      if (this.cancelled) this.controller.abort(new FetchCancelled(this.reasonValue));
    }
    return this.controller.signal;
  }

  /**
   * Resolves when the fetch is cancelled, for a source that would rather race
   * than poll: `await Promise.race([request, signal.whenCancelled])`.
   */
  get whenCancelled(): Promise<void> {
    if (this.pending === null) {
      if (this.cancelled) {
        this.pending = Promise.resolve();
      } else {
        this.pending = new Promise<void>((resolve) => {
          this.resolvePending = resolve;
        });
      }
    }
    return this.pending;
  }

  /**
   * Runs `listener` when the fetch is cancelled, or immediately if it already
   * has been.
   */
  onCancel(listener: () => void): void {
    if (this.cancelled) {
      listener();
      return;
    }
    (this.listeners ??= []).push(listener);
  }

  /**
   * Throws {@link FetchCancelled} if the fetch has been cancelled.
   *
   * The cheapest way for a source to bail out part-way through work it is
   * doing itself.
   */
  throwIfCancelled(): void {
    if (this.cancelled) throw new FetchCancelled(this.reasonValue);
  }

  /**
   * Cancels the fetch. Called by the grid, which owns the signal; calling it
   * twice does nothing.
   */
  cancel(reason?: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.reasonValue = reason ?? null;
    const listeners = this.listeners;
    this.listeners = null;
    // One listener that throws must not keep the others from hearing about
    // the cancellation — a socket left open because the listener before it
    // failed is exactly the leak this class exists to prevent. The first
    // error is rethrown afterwards.
    let firstError: unknown = null;
    let failed = false;
    if (listeners !== null) {
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          if (!failed) {
            firstError = error;
            failed = true;
          }
        }
      }
    }
    this.controller?.abort(new FetchCancelled(this.reasonValue));
    this.resolvePending?.();
    this.resolvePending = null;
    this.pending ??= Promise.resolve();
    if (failed) throw firstError;
  }
}
