// The difficulty report writes its shard results to disk, and the CLIENT package carries
// no `@types/node` on purpose: adding it would put `process`, `Buffer` and friends in
// scope for every browser file, which is exactly the confusion a browser app does not
// want. So the two functions this folder needs are declared here instead.
//
// A MODULE declaration and nothing else — it introduces no globals, so it cannot leak
// node into the game's own type environment. Anything beyond writing a JSON file belongs
// in `tools/`, which runs under plain node.
declare module "node:fs" {
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}
