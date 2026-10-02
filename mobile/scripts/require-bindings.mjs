import { bindingsExist } from './native-build.mjs';

if (!bindingsExist()) {
  console.error('\nThe native bindings have not been generated: build the native bindings first: pnpm native:ios:sim\n');
  process.exit(1);
}
