import { describe, expect, it } from 'vitest';
import {
  AsyncDataSource,
  FetchCancelled,
  FetchSignal,
  FilterCondition,
  FilterOperator,
  GridController,
  GridDataSource,
  GridQuery,
  GridResult,
} from '../src/index';
import {
  Product,
  productColumns,
  productGrid,
  sampleProducts,
} from './fixtures';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Records the queries it is asked for and whether each one was cancelled. */
class RecordingSource extends GridDataSource<Product> {
  readonly searches: string[] = [];
  readonly signals: FetchSignal[] = [];
  aborted = 0;

  constructor(private readonly delay = 0) {
    super();
  }

  override get supportsCancellation(): boolean {
    return true;
  }

  override async fetch(query: GridQuery): Promise<GridResult<Product>> {
    this.searches.push(query.search);
    const signal = query.signal;
    if (signal !== null) this.signals.push(signal);
    await wait(this.delay);
    if (signal !== null && signal.isCancelled) {
      this.aborted++;
      throw new FetchCancelled(signal.reason);
    }
    return new GridResult<Product>({
      rows: sampleProducts(),
      totalCount: sampleProducts().length,
    });
  }
}

describe('FetchSignal', () => {
  it('runs the listeners once and only once on cancel', () => {
    const signal = new FetchSignal();
    let calls = 0;
    signal.onCancel(() => calls++);
    signal.cancel();
    signal.cancel();
    expect(calls).toBe(1);
    expect(signal.isCancelled).toBe(true);
  });

  it('runs a listener added after cancellation immediately', () => {
    const signal = new FetchSignal();
    signal.cancel('gone');
    let called = false;
    signal.onCancel(() => {
      called = true;
    });
    expect(called).toBe(true);
    expect(signal.reason).toBe('gone');
  });

  it('bails out of work a source does itself', () => {
    const signal = new FetchSignal();
    expect(() => signal.throwIfCancelled()).not.toThrow();
    signal.cancel();
    expect(() => signal.throwIfCancelled()).toThrow(FetchCancelled);
  });

  it('resolves whenCancelled, before or after the fact', async () => {
    const early = new FetchSignal();
    const waiting = early.whenCancelled;
    early.cancel();
    await waiting;

    const already = new FetchSignal();
    already.cancel();
    await already.whenCancelled;
  });

  it('aborts a standard AbortSignal, for fetch to listen to', () => {
    const signal = new FetchSignal();
    const abort = signal.abortSignal;
    expect(abort.aborted).toBe(false);
    signal.cancel('superseded');
    expect(abort.aborted).toBe(true);
    expect((abort.reason as FetchCancelled).reason).toBe('superseded');
  });

  it('is left out of the query JSON', () => {
    const query = new GridQuery({ search: 'x', signal: new FetchSignal() });
    expect('signal' in query.toJSON()).toBe(false);
    expect(query.copyWith({ search: 'y' }).signal).not.toBeNull();
  });
});

describe('cancellation', () => {
  it('tells a superseded fetch to stop', async () => {
    const source = new RecordingSource(20);
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
    });
    grid.setSearch('a');
    grid.setSearch('ab');
    await grid.refresh();

    expect(source.signals[0]?.isCancelled).toBe(true);
    expect(source.signals[source.signals.length - 1]?.isCancelled).toBe(false);
    expect(source.aborted).toBeGreaterThan(0);
    expect(grid.error, 'cancellation is not a failure').toBeNull();
    expect(grid.rowCount).toBe(6);
  });

  it('cancels whatever is in flight when disposed', () => {
    const source = new RecordingSource(10);
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
    });
    grid.dispose();
    expect(source.signals).toHaveLength(1);
    expect(source.signals[0]?.isCancelled).toBe(true);
  });
});

describe('debounce', () => {
  it('sends one request for a word typed into the search box', async () => {
    const source = new RecordingSource();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      fetchDebounceMs: 20,
    });
    await wait(0);
    source.searches.length = 0;

    for (const text of ['m', 'mo', 'mou', 'mous', 'mouse']) {
      grid.setSearch(text);
    }
    expect(grid.isFetchPending).toBe(true);
    expect(source.searches).toEqual([]);

    grid.setSearch('mouse!');
    await wait(50);
    expect(source.searches).toEqual(['mouse!']);
    expect(grid.isFetchPending).toBe(false);
  });

  it('resolves the promise a debounced refresh returns with the fetch', async () => {
    const source = new RecordingSource();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      fetchDebounceMs: 10,
    });
    await wait(0);
    source.searches.length = 0;

    const first = grid.refresh({ coalesce: true });
    const second = grid.refresh({ coalesce: true });
    await Promise.all([first, second]);
    expect(source.searches).toHaveLength(1);
  });

  it('debounces a filter-row change too', async () => {
    const source = new RecordingSource();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      fetchDebounceMs: 20,
    });
    await wait(0);
    source.searches.length = 0;

    grid.setColumnFilter(
      'name',
      new FilterCondition({
        field: 'name',
        operator: FilterOperator.contains,
        value: 'mo',
      }),
    );
    expect(source.searches).toEqual([]);
    await wait(50);
    expect(source.searches).toHaveLength(1);
  });

  it('never debounces a local source: it answers in the frame', () => {
    const grid = productGrid();
    grid.fetchDebounceMs = 5000;
    grid.setSearch('mouse');
    expect(grid.isFetchPending).toBe(false);
    expect(grid.rowCount).toBe(1);
  });

  it('drops a pending debounce when the grid is disposed', async () => {
    const source = new RecordingSource();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      fetchDebounceMs: 10,
    });
    await wait(0);
    source.searches.length = 0;
    grid.setSearch('x');
    grid.dispose();
    await wait(40);
    expect(source.searches).toEqual([]);
  });

  it('answers a caller still awaiting a dropped debounce', async () => {
    const source = new RecordingSource();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      fetchDebounceMs: 10,
    });
    await wait(0);
    const pending = grid.refresh({ coalesce: true });
    grid.dispose();
    // Leaving it unresolved would hang this test rather than fail it.
    await pending;
  });
});

describe('keepRowsOnError', () => {
  function failingGrid(options: { keepRowsOnError?: boolean } = {}): {
    grid: GridController<Product>;
    fail: (on: boolean) => void;
  } {
    let failing = false;
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new AsyncDataSource<Product>(async () => {
        if (failing) throw new Error('offline');
        return new GridResult<Product>({
          rows: sampleProducts(),
          totalCount: 6,
        });
      }),
      keepRowsOnError: options.keepRowsOnError ?? false,
    });
    return {
      grid,
      fail: (on: boolean) => {
        failing = on;
      },
    };
  }

  it('empties the grid on a failed fetch when off', async () => {
    const { grid, fail } = failingGrid();
    await wait(0);
    expect(grid.rowCount).toBe(6);
    fail(true);
    await grid.refresh();
    expect(grid.rowCount).toBe(0);
    expect(grid.error).toBeInstanceOf(Error);
    expect(grid.isStale).toBe(false);
  });

  it('keeps the last good rows on screen beside the error when on', async () => {
    const { grid, fail } = failingGrid({ keepRowsOnError: true });
    await wait(0);
    fail(true);
    await grid.refresh();
    expect(grid.rowCount).toBe(6);
    expect(grid.error).toBeInstanceOf(Error);
    expect(grid.isStale).toBe(true);
  });
});
