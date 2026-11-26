import { Migration20261125174811 } from "../../../dunning/migrations/Migration20261125174811"
import { Migration20261125174812 } from "../../migrations/Migration20261125174812"

function build(Migration: typeof Migration20261125174811 | typeof Migration20261125174812, count: number) {
  const execute = jest.fn(async () => [{ count }])

  return { migration: new Migration({ execute } as never, {} as never), execute }
}

describe.each([
  ["renewal_cycle", Migration20261125174812, "renewal cycle(s)"],
  ["dunning_case", Migration20261125174811, "dunning case(s)"],
])("reverting the %s awaiting_payment status", (table, Migration, rows) => {
  it("is refused while a row still awaits payment, queueing nothing", async () => {
    const { migration, execute } = build(Migration, 2)

    await expect(migration.down()).rejects.toThrow(`2 ${rows} still await a payment answer`)
    expect(execute).toHaveBeenCalledWith(expect.stringContaining(`from "${table}" where "status" = 'awaiting_payment'`), undefined, "all", undefined)
    expect(migration.getQueries()).toEqual([])
  })

  it("restores the old status check once no row awaits payment", async () => {
    const { migration } = build(Migration, 0)

    await migration.down()

    expect(migration.getQueries()).toEqual([
      expect.stringContaining(`drop constraint if exists "${table}_status_check"`),
      expect.not.stringContaining("awaiting_payment"),
    ])
  })
})
