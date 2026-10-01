// node --import ./tests/stubs/register.mjs <script>: run a script with Claude stubbed out.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
