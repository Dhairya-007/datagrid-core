// Async lifecycle fixes from the 0.4.0 review: promises that never resolved,
// a spinner that never stopped, and state that outlived its query.
import { describe, expect, it } from 'vitest';
import {
  FetchCancelled,
  GridController,
  GridDataSource,
  GridResult,
  GroupSpec,
  InMemoryDataSource,
} from '../src/index';
import { Product, productColumns, sampleProducts } from './fixtures';

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class SlowSource extends GridDataSource<Product> {
  fetches = 0;

  constructor(private readonly delay = 0) {
    super();
  }

  override async fetch(): Promise<GridResult<Product>> {
    this.fetches++;
    await wait(this.delay);
    return new GridResult<Product>({
      rows: sampleProducts(),
      totalCount: sampleProducts().length,
    });
  }
}

/**
 * A source that maps its own aborted request onto FetchCancelled, which is
 * what an HTTP client's abort looks like from the outside.
 */
class SelfCancellingSource extends GridDataSource<Product> {
  override async fetch(): Promise<GridResult<Product>> {
    await wait(0);
    throw new FetchCancelled('the connection was aborted');
  }
}

class FailingSource extends GridDataSource<Product> {
  fail = false;

  override async fetch(): Promise<GridResult<Product>> {
    await wait(0);
    if (this.fail) throw new Error('no');
    return new GridResult<Product>({
      rows: sampleProducts(),
      totalCount: sampleProducts().length,
      filteredCount: sampleProducts().length,
    });
  }
}

/** Fails the test rather than hanging it if the promise never resolves. */
function withTimeout(promise: Promise<void>, ms = 1000): Promise<void> {
  return Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error(`a promise did not resolve inside ${ms}ms`);
    }),
  ]);
}

describe('a debounced refresh', () => {
  it('resolves when the grid is disposed', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new SlowSource(),
      fetchDebounceMs: 10_000,
    });
    const pending = grid.refresh({ coalesce: true });
    grid.dispose();
    // Without this, the caller waits for the life of the process.
    await withTimeout(pending);
  });

  it('resolves when a direct refresh overtakes it', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new SlowSource(),
      fetchDebounceMs: 10_000,
    });
    const coalesced = grid.refresh({ coalesce: true });
    await grid.refresh();
    await withTimeout(coalesced);
    grid.dispose();
  });
});

describe('a FetchCancelled the grid did not ask for', () => {
  it('stops the spinner and surfaces the error', async () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new SelfCancellingSource(),
    });
    await grid.refresh();
    expect(grid.isLoading).toBe(false);
    expect(grid.error).toBeInstanceOf(FetchCancelled);
    grid.dispose();
  });
});

describe('after a failed fetch', () => {
  it('does not let the counts describe rows that are gone', async () => {
    const source = new FailingSource();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
    });
    await grid.refresh();
    expect(grid.matchedCount).toBe(sampleProducts().length);

    source.fail = true;
    await grid.refresh();
    expect(grid.rowCount).toBe(0);
    expect(grid.matchedCount, 'the footer must not lie').toBe(0);
    expect(grid.totalCount).toBe(0);
    expect(grid.isStale).toBe(false);
    grid.dispose();
  });

  it('keeps the rows and says they are stale with keepRowsOnError', async () => {
    const source = new FailingSource();
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      keepRowsOnError: true,
    });
    await grid.refresh();
    source.fail = true;
    await grid.refresh();
    expect(grid.rowCount).toBeGreaterThan(0);
    expect(grid.isStale).toBe(true);
    grid.dispose();
  });
});

describe('paging', () => {
  it('clamps the page when the data shrinks under it', () => {
    const source = new InMemoryDataSource<Product>(sampleProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      pageSize: 2,
    });
    grid.goToPage(grid.pageCount - 1);
    expect(grid.pageIndex).toBeGreaterThan(0);

    source.setRows([sampleProducts()[0] as Product]);
    expect(grid.pageCount).toBe(1);
    expect(grid.pageIndex).toBe(0);
    expect(grid.rowCount, 'rows exist, so rows must be shown').toBe(1);
    grid.dispose();
  });

  it('reports the one page a grouped grid can turn', () => {
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(sampleProducts()),
      pageSize: 2,
      groups: [new GroupSpec('category')],
    });
    expect(grid.pageCount).toBe(1);
    expect(grid.hasNextPage).toBe(false);
    grid.dispose();
  });
});
