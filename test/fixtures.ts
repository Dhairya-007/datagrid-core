import {
  Aggregation,
  ColumnType,
  GridColumn,
  GridController,
  GroupSpec,
  InMemoryDataSource,
  isDataRow,
  isGroupRow,
  numberRange,
  requiredValue,
  SelectionMode,
  SortSpec,
  type CellValue,
} from '../src/index';

/** Mutable row model, so editing tests can exercise in-place writes. */
export class Product {
  readonly id: number;
  name: string;
  category: string;
  price: number;
  stock: number | null;
  active: boolean;

  constructor(options: {
    id: number;
    name: string;
    category: string;
    price: number;
    stock?: number | null;
    active?: boolean;
  }) {
    this.id = options.id;
    this.name = options.name;
    this.category = options.category;
    this.price = options.price;
    this.stock = options.stock ?? null;
    this.active = options.active ?? true;
  }

  toString(): string {
    return `Product(${this.id}, ${this.name})`;
  }
}

export function productColumns(): GridColumn<Product>[] {
  return [
    new GridColumn<Product>({
      field: 'name',
      value: (p) => p.name,
      setValue: (p, v) => {
        p.name = (v ?? '') as string;
        return null;
      },
      validator: requiredValue(),
    }),
    new GridColumn<Product>({ field: 'category', value: (p) => p.category }),
    new GridColumn<Product>({
      field: 'price',
      type: ColumnType.number,
      value: (p) => p.price,
      format: (v: CellValue) =>
        v === null || v === undefined ? '' : `${(v as number).toFixed(2)} USD`,
      setValue: (p, v) => {
        p.price = (v ?? 0) as number;
        return null;
      },
      validator: numberRange({ min: 0 }),
    }),
    new GridColumn<Product>({
      field: 'stock',
      type: ColumnType.number,
      value: (p) => p.stock,
    }),
    new GridColumn<Product>({
      field: 'active',
      type: ColumnType.boolean,
      value: (p) => p.active,
    }),
  ];
}

export function sampleProducts(): Product[] {
  return [
    new Product({
      id: 1,
      name: 'Keyboard',
      category: 'Input',
      price: 80,
      stock: 12,
    }),
    new Product({
      id: 2,
      name: 'Mouse',
      category: 'Input',
      price: 25,
      stock: 40,
    }),
    new Product({
      id: 3,
      name: 'Monitor',
      category: 'Display',
      price: 320,
      stock: 5,
    }),
    new Product({ id: 4, name: 'Laptop', category: 'Compute', price: 1450 }),
    new Product({
      id: 5,
      name: 'Dock',
      category: 'Compute',
      price: 180,
      stock: 7,
      active: false,
    }),
    new Product({
      id: 6,
      name: 'Webcam',
      category: 'Input',
      price: 60,
      stock: 0,
    }),
  ];
}

export function productColumnMap(): Map<string, GridColumn<Product>> {
  return new Map(productColumns().map((c) => [c.field, c]));
}

/** Builds a controller over the sample data. */
export function productGrid(
  options: {
    sorts?: readonly SortSpec[];
    groups?: readonly GroupSpec[];
    aggregations?: readonly Aggregation[];
    pageSize?: number | null;
    selectionMode?: SelectionMode;
    rows?: Product[];
    identified?: boolean;
  } = {},
): GridController<Product> {
  return new GridController<Product>({
    columns: productColumns(),
    dataSource: new InMemoryDataSource<Product>(
      options.rows ?? sampleProducts(),
    ),
    sorts: options.sorts ?? [],
    groups: options.groups ?? [],
    aggregations: options.aggregations ?? [],
    pageSize: options.pageSize ?? null,
    selectionMode: options.selectionMode ?? SelectionMode.multiRow,
    ...(options.identified === true ? { rowKey: (p: Product) => p.id } : {}),
  });
}

/** Row labels in display order: product names, and group labels for headers. */
export function labelsOf(grid: GridController<Product>): string[] {
  const out: string[] = [];
  for (const row of grid.visibleRows) {
    if (isDataRow(row)) out.push(row.data.name);
    else if (isGroupRow(row)) out.push(row.label);
    else out.push('(detail)');
  }
  return out;
}

/** The data rows on screen, group headers skipped. */
export function dataOf(grid: GridController<Product>): Product[] {
  const out: Product[] = [];
  for (const row of grid.visibleRows) {
    if (isDataRow(row)) out.push(row.data);
  }
  return out;
}
