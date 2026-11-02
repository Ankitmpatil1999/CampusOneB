/**
 * Sends the school tables to the CUG database (client 2026-10-21; db/cug-tables.ts). Every Kysely
 * query keeps writing plain table names; this plugin puts `<cug>.` before each CUG table — in
 * FROM, JOIN, INTO, UPDATE, DELETE and `table.column` references — and the same in raw `sql`
 * fragments, after FROM, JOIN, INTO, UPDATE or TABLE. CampusOne tables stay as written (the
 * connection's own database). A common table expression with a CUG table's name is left alone.
 */
import {
  IdentifierNode,
  OperationNodeTransformer,
  RawNode,
  type CommonTableExpressionNode,
  type KyselyPlugin,
  type OperationNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type SchemableIdentifierNode,
  type UnknownRow,
} from 'kysely';
import { isCugTable, qualifyCugSql } from '../db/cug-tables';

class CugSchemaTransformer extends OperationNodeTransformer {
  /** Names of the common table expressions in the query being transformed. */
  readonly #ctes = new Set<string>();

  constructor(private readonly cug: string) {
    super();
  }

  protected override transformNodeImpl<T extends OperationNode>(node: T, queryId: QueryId): T {
    const added: string[] = [];
    const withNode = (node as { with?: { expressions?: readonly { name: unknown }[] } }).with;
    for (const e of withNode?.expressions ?? []) {
      const name = (e.name as { table?: { table?: { identifier?: { name?: string } } } }).table
        ?.table?.identifier?.name;
      if (name && !this.#ctes.has(name)) {
        this.#ctes.add(name);
        added.push(name);
      }
    }
    try {
      return super.transformNodeImpl(node, queryId);
    } finally {
      for (const n of added) this.#ctes.delete(n);
    }
  }

  /** Inside its own definition a (non-recursive) CTE's name is the real table again. */
  protected override transformCommonTableExpression(
    node: CommonTableExpressionNode,
    queryId: QueryId,
  ): CommonTableExpressionNode {
    const name = node.name.table.table.identifier.name;
    const had = this.#ctes.delete(name);
    try {
      // The CTE's own name is never a table: kept as written.
      return { ...super.transformCommonTableExpression(node, queryId), name: node.name };
    } finally {
      if (had) this.#ctes.add(name);
    }
  }

  protected override transformSchemableIdentifier(
    node: SchemableIdentifierNode,
    queryId: QueryId,
  ): SchemableIdentifierNode {
    const t = super.transformSchemableIdentifier(node, queryId);
    const name = t.identifier.name;
    if (t.schema || !isCugTable(name) || this.#ctes.has(name)) return t;
    return { ...t, schema: IdentifierNode.create(this.cug) };
  }

  protected override transformRaw(node: RawNode, queryId: QueryId): RawNode {
    const t = super.transformRaw(node, queryId);
    const fragments = t.sqlFragments.map((f) => qualifyCugSql(f, this.cug));
    return fragments.some((f, i) => f !== t.sqlFragments[i])
      ? RawNode.create(fragments, t.parameters)
      : t;
  }
}

export class CugSchemaPlugin implements KyselyPlugin {
  readonly #transformer: CugSchemaTransformer;

  constructor(readonly cugDatabase: string) {
    this.#transformer = new CugSchemaTransformer(cugDatabase);
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node, args.queryId);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
