// Remote-write and undo fixes from the 0.4.0 review.
import { describe, expect, it } from 'vitest';
import {
  CellAddress,
  GridController,
  GridDataSource,
  GridResult,
  InMemoryDataSource,
  RowUpdate,
} from '../src/index';
import { Product, productColumns } from './fixtures';

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** A remote source: rows in memory, writes that resolve when told to. */
class Backend extends GridDataSource<Product> {
  readonly gates: Gate[] = [];
  refuse = false;

  constructor(readonly rows: Product[]) {
    super();
  }

  override get canCommit(): boolean {
    return true;
  }

  override async fetch(): Promise<GridResult<Product>> {
    return new GridResult<Product>({
      rows: [...this.rows],
      totalCount: this.rows.length,
      filteredCount: this.rows.length,
    });
  }

  override async commit(
    _original: Product,
    updated: Product,
  ): Promise<Product> {
    const held = gate();
    this.gates.push(held);
    await held.promise;
    if (this.refuse) throw new Error('the server said no');
    return updated;
  }
}

/** A local source that refuses every write. */
class RefusingLocal extends InMemoryDataSource<Product> {
  override async commitAll(
    _writes: readonly RowUpdate<Product>[],
  ): Promise<Product[]> {
    throw new Error('read-only today');
  }
}

function remoteGrid(backend: Backend): GridController<Product> {
  return new GridController<Product>({
    columns: productColumns(),
    dataSource: backend,
    rowKey: (p) => p.id,
  });
}

describe('two writes to one row', () => {
  it('does not let the finishing write wipe the newer one', async () => {
    const backend = new Backend([
      new Product({ id: 1, name: 'first-ish', category: 'c', price: 1 }),
    ]);
    const grid = remoteGrid(backend);
    await grid.refresh();

    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('first');
    grid.commitEdit();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('second');
    grid.commitEdit();

    expect(grid.dataAt(0)?.name).toBe('second');

    // The first write lands while the second is still in flight.
    backend.gates[0]?.open();
    await tick();
    await tick();

    expect(grid.dataAt(0)?.name, 'the newer write owns the cell').toBe(
      'second',
    );
    grid.dispose();
  });
});

describe('a refused write', () => {
  it('puts the value back on a model that mutates in place', async () => {
    const product = new Product({
      id: 1,
      name: 'a',
      category: 'c',
      price: 80,
    });
    const backend = new Backend([product]);
    backend.refuse = true;
    const grid = remoteGrid(backend);
    await grid.refresh();

    grid.beginEdit(new CellAddress(0, 'price'));
    grid.updateEdit(999);
    grid.commitEdit();
    expect(product.price, 'shown at once, optimistically').toBe(999);

    backend.gates[0]?.open();
    await grid.pendingWrite;

    expect(grid.writeError).toBeInstanceOf(Error);
    expect(product.price, 'the refused value must not stay').toBe(80);
    expect(grid.dataAt(0)?.price).toBe(80);
    grid.dispose();
  });

  it('puts the value back after a refused local write too', async () => {
    const product = new Product({
      id: 1,
      name: 'a',
      category: 'c',
      price: 80,
    });
    const source = new RefusingLocal([product]);
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
      rowKey: (p) => p.id,
    });
    grid.beginEdit(new CellAddress(0, 'price'));
    grid.updateEdit(999);
    grid.commitEdit();
    await grid.pendingWrite;
    expect(grid.writeError).not.toBeNull();
    expect(product.price).toBe(80);
    grid.dispose();
  });
});

describe('committing an unchanged value', () => {
  it('writes nothing and records no undo step', async () => {
    const backend = new Backend([
      new Product({ id: 1, name: 'a', category: 'c', price: 1 }),
    ]);
    const grid = remoteGrid(backend);
    await grid.refresh();

    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('a');
    grid.commitEdit();
    await tick();

    expect(backend.gates, 'nothing to save').toEqual([]);
    expect(grid.canUndo).toBe(false);
    grid.dispose();
  });
});

describe('undo', () => {
  it('restores every row a paste touched, in view or not', () => {
    const products = [
      new Product({ id: 1, name: 'Keyboard', category: 'Input', price: 1 }),
      new Product({ id: 2, name: 'Mouse', category: 'Input', price: 2 }),
    ];
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: new InMemoryDataSource<Product>(products),
      rowKey: (p) => p.id,
    });
    grid.pasteText('K2\nM2', { at: new CellAddress(0, 'name') });
    expect(products.map((p) => p.name)).toEqual(['K2', 'M2']);

    grid.setSearch('M2');
    expect(grid.rowCount).toBe(1);
    expect(grid.undo()).toBe(true);
    expect(grid.lastReplay.isComplete).toBe(true);

    grid.setSearch('');
    expect(products.map((p) => p.name)).toEqual(['Keyboard', 'Mouse']);
    grid.dispose();
  });

  it('keeps its step when an undo cannot be applied', async () => {
    const backend = new Backend([
      new Product({ id: 1, name: 'a', category: 'c', price: 1 }),
    ]);
    const grid = remoteGrid(backend);
    await grid.refresh();
    grid.beginEdit(new CellAddress(0, 'name'));
    grid.updateEdit('b');
    grid.commitEdit();
    backend.gates[0]?.open();
    await grid.pendingWrite;

    // A remote source cannot enumerate its rows, so emptying the view leaves
    // undo nothing to resolve against.
    backend.rows.length = 0;
    await grid.refresh();

    expect(grid.undo()).toBe(false);
    expect(grid.canUndo, 'the step is still there').toBe(true);
    expect(grid.canRedo).toBe(false);
    expect(grid.lastReplay.unresolved).toBe(1);
    grid.dispose();
  });
});
