/**
 * Executa um item da especificação de testes (seção 13 do enunciado).
 *
 *   bun run test:spec list                     # lista os itens
 *   bun run test:spec concorrencia:aposta-50x  # executa um item
 *   bun run test:spec concorrencia             # executa um grupo inteiro
 *
 * Os itens estão em test/spec-catalog.ts.
 */
import { type Spec, specs } from "./spec-catalog.js";

const root = `${import.meta.dir}/..`;

function list(): void {
  let group = "";
  for (const spec of specs) {
    if (spec.group !== group) {
      group = spec.group;
      console.log(`\n${group.toUpperCase()}`);
    }
    console.log(`  ${spec.id.padEnd(38)} ${spec.requirement}`);
  }
  console.log(
    "\nUso: bun run test:spec <id | grupo> [...]   (ex.: concorrencia:aposta-50x)",
  );
}

function select(args: string[]): Spec[] {
  const chosen: Spec[] = [];
  for (const arg of args) {
    const matches = specs.filter((s) => s.id === arg || s.group === arg);
    if (matches.length === 0) {
      console.error(`Especificação desconhecida: "${arg}".`);
      list();
      process.exit(2);
    }
    for (const spec of matches) if (!chosen.includes(spec)) chosen.push(spec);
  }
  return chosen;
}

function run(spec: Spec): boolean {
  const env: Record<string, string | undefined> = { ...process.env };
  if (spec.group !== "unidade") env.RUN_POSTGRES_INTEGRATION = "true";
  if (spec.group === "carga") env.RUN_FINANCIAL_LOAD = "true";

  console.log(`\n━━ ${spec.id} — ${spec.requirement}`);
  let ok = true;
  for (const step of spec.runs) {
    const cmd = ["bun", "test", ...step.paths.map((p) => `./${p}`)];
    if (step.pattern) cmd.push("--test-name-pattern", step.pattern);
    const result = Bun.spawnSync(cmd, {
      cwd: root,
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
    ok &&= result.exitCode === 0;
  }
  return ok;
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "list") {
  list();
  process.exit(0);
}

const failed = select(args)
  .filter((spec) => !run(spec))
  .map((s) => s.id);
if (failed.length > 0) {
  console.error(`\nFalharam: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("\nTodas as especificações selecionadas passaram.");
