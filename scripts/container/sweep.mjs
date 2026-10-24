// Removes every leftover supplier-disruption-ct-* container, volume, network
// and test image, for example after a container test run was interrupted
// before its teardown ran. Never touches the supplier-disruption project.
import { sweep } from "./support.mjs";

const removed = await sweep();
process.stdout.write(removed.length === 0 ? "nothing to remove\n" : `${removed.join("\n")}\n`);
