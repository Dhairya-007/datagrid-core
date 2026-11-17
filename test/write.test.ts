import { describe, expect, it } from 'vitest';
import {
  AsyncDataSource,
  CellAddress,
  ColumnType,
  GridColumn,
  GridController,
  GridResult,
  GridStateError,
  InMemoryDataSource,
  requiredValue,
  SortSpec,
} from '../src/index';
import { labelsOf, Product, productColumns, productGrid, sampleProducts } from './fixtures';

/**
 * An immutable row, which is what makes a lost write visible: an in-place
 * model would keep the new value whether or not the source stored it.
 */
class Task {
  constructor(
    readonly id: number,
    readonly title: string,
  ) {}
}

function taskColumns(): GridColumn<Task>[] {
  return [
    new GridColumn<Task>({
      field: 'title',
      value: (t) => t.title,
      setValue: (t, v) => new Task(t.id, (v ?? '') as string),
    }),
    new GridColumn<Task>({
      field: 'id',
      type: ColumnType.number,
      value: (t) => t.id,
    }),
  ];
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * A stand-in for a server: it hands out fresh instances on every fetch, so a
 * grid that does not track its write loses it.
 */
class FakeBackend {
  rows: Task[];
  fetches = 0;
  failWith: unknown = null;
  readonly gates: { promise: Promise<void>; open: () => void }[] = [];

  constructor(rows: Task[]) {
    this.rows = rows;
  }

  source(): AsyncDataSource<Task> {
    return new AsyncDataSource<Task>(
      async () => {
        this.fetches++;
        return new GridResult<Task>({
          rows: this.rows.map((t) => new Task(t.id, t.title)),
          totalCount: this.rows.length,
        });
      },
      {
        onCommit: async (_original, updated) => {
          const next = this.gates.shift();
          if (next !== undefined) await next.promise;
          if (this.failWith !== null) throw this.failWith;
          this.rows = this.rows.map((t) => (t.id === updated.id ? updated : t));
          return updated;
        },
      },
    );
  }
}

function taskGrid(backend: FakeBackend): GridController<Task> {
  return new GridController<Task>({
    columns: taskColumns(),
    dataSource: backend.source(),
    rowKey: (t) => t.id,
  });
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('a source that cannot write', () => {
  it('refuses to open an editor rather than lose the value', () => {
    const grid = new GridController<Task>({
      columns: taskColumns(),
      dataSource: new AsyncDataSource<Task>(
        async () => new GridResult<Task>({ rows: [], totalCount: 0 }),
      ),
    });
    expect(grid.canEdit).toBe(false);
    expect(grid.beginEdit(new CellAddress(0, 'title'))).toBeNull();
  });

  it('has an in-memory source say that it can write', () => {
    const grid = productGrid();
    expect(grid.canEdit).toBe(true);
  });
});

describe('committing to a remote source', () => {
  it('puts the new value on screen before the server confirms it', async () => {
    const backend = new FakeBackend([new Task(1, 'Write docs')]);
    const grid = taskGrid(backend);
    await tick();

    const held = gate();
    backend.gates.push(held);
    grid.beginEdit(new CellAddress(0, 'title'));
    grid.updateEdit('Write better docs');
    expect(grid.commitEdit().isCommitted).toBe(true);

    expect(grid.dataAt(0)?.title).toBe('Write better docs');
    expect(grid.hasPendingWrites).toBe(true);

    held.open();
    await grid.pendingWrite;
    expect(grid.dataAt(0)?.title).toBe('Write better docs');
    expect(grid.hasPendingWrites).toBe(false);
    expect(grid.writeError).toBeNull();
  });

  it('cannot bring the old value back with the re-fetch that follows', async () => {
    const backend = new FakeBackend([new Task(1, 'a'), new Task(2, 'b')]);
    const grid = taskGrid(backend);
    await tick();
    const before = backend.fetches;

    grid.beginEdit(new CellAddress(1, 'title'));
    grid.updateEdit('b2');
    grid.commitEdit();
    await grid.pendingWrite;

    expect(backend.fetches).toBeGreaterThan(before);
    expect(grid.dataAt(1)?.title).toBe('b2');
    expect(backend.rows[1]?.title).toBe('b2');
  });

  it('rolls back and reports why when the server refuses a write', async () => {
    const backend = new FakeBackend([new Task(1, 'a')]);
    backend.failWith = new Error('conflict');
    const grid = taskGrid(backend);
    await tick();

    grid.beginEdit(new CellAddress(0, 'title'));
    grid.updateEdit('a2');
    grid.commitEdit();
    expect(grid.dataAt(0)?.title, 'shown optimistically').toBe('a2');

    await grid.pendingWrite;
    expect(grid.dataAt(0)?.title).toBe('a');
    expect(grid.writeError).toBeInstanceOf(Error);
    expect(grid.hasPendingWrites).toBe(false);

    grid.clearWriteError();
    expect(grid.writeError).toBeNull();
  });

  it('keeps the session open and writes nothing for a rejected value', async () => {
    const backend = new FakeBackend([new Task(1, 'a')]);
    const grid = new GridController<Task>({
      columns: [
        new GridColumn<Task>({
          field: 'title',
          value: (t) => t.title,
          setValue: (t, v) => new Task(t.id, (v ?? '') as string),
          validator: requiredValue(),
        }),
      ],
      dataSource: backend.source(),
      rowKey: (t) => t.id,
    });
    await tick();

    grid.beginEdit(new CellAddress(0, 'title'));
    grid.updateEdit('');
    const result = grid.commitEdit();
    expect(result.isRejected).toBe(true);
    expect(grid.editSession).not.toBeNull();
    expect(grid.hasPendingWrites).toBe(false);
    expect(backend.rows).toHaveLength(1);
    expect(backend.rows[0]?.title).toBe('a');
  });

  it('shows a normalised value as the source stored it', async () => {
    const rows = [new Task(1, 'a')];
    const source = new AsyncDataSource<Task>(
      async () =>
        new GridResult<Task>({
          rows: rows.map((t) => new Task(t.id, t.title)),
          totalCount: rows.length,
        }),
      {
        onCommit: async (_original, updated) => {
          const stored = new Task(updated.id, updated.title.toUpperCase());
          rows[0] = stored;
          return stored;
        },
      },
    );
    const grid = new GridController<Task>({
      columns: taskColumns(),
      dataSource: source,
      rowKey: (t) => t.id,
    });
    await tick();

    grid.beginEdit(new CellAddress(0, 'title'));
    grid.updateEdit('shout');
    grid.commitEdit();
    await grid.pendingWrite;
    expect(grid.dataAt(0)?.title).toBe('SHOUT');
  });
});

describe('committing to a local source', () => {
  it('writes through and moves the row if the sort key changed', () => {
    const grid = productGrid({ sorts: [new SortSpec('name')] });
    expect(labelsOf(grid)[0]).toBe('Dock');
    grid.beginEdit(new CellAddress(labelsOf(grid).indexOf('Webcam'), 'name'));
    grid.updateEdit('Aardvark');
    expect(grid.commitEdit().isCommitted).toBe(true);
    expect(labelsOf(grid)[0]).toBe('Aardvark');
  });

  it('reports the failure when a row is removed under the edit', async () => {
    const source = new InMemoryDataSource<Product>(sampleProducts());
    const grid = new GridController<Product>({
      columns: productColumns(),
      dataSource: source,
    });
    const target = source.rows[1] as Product;
    grid.beginEdit(new CellAddress(1, 'name'));
    grid.updateEdit('Gone');
    source.remove(target);
    grid.commitEdit();
    await grid.pendingWrite;
    expect(grid.writeError).toBeInstanceOf(GridStateError);
  });
});
