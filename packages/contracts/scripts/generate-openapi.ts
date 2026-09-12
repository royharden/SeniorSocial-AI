import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { generateOpenApiDocument, generateOpenApiYaml } from '../src/index.ts';

const args = process.argv.slice(2).filter(argument => argument !== '--');
if (args.length === 1 && args[0] === '--stdout') {
  process.stdout.write(generateOpenApiYaml());
} else if (args.length === 1 && args[0] === '--adopt') {
  const yaml = generateOpenApiYaml();
  const generated = generateOpenApiDocument();
  const version = generated['x-contract-version'];
  if (typeof version !== 'number' && typeof version !== 'string') throw new Error('Missing contract version');
  const root = new URL('../../../', import.meta.url);
  const digest = createHash('sha256').update(yaml).digest('hex');
  writeFileSync(new URL('agentops/interfaces/openapi.yaml', root), yaml);
  writeFileSync(new URL('tests/contract/WP-002/primary-interface.snapshot.json', root),
    `${JSON.stringify(generated, null, 2)}\n`);
  const pinsUrl = new URL('tests/contract/WP-002/source-pins.json', root);
  const pins = JSON.parse(readFileSync(pinsUrl, 'utf8')) as Record<string, string>;
  pins['openapi.yaml'] = digest;
  writeFileSync(pinsUrl, `${JSON.stringify(pins, null, 2)}\n`);
  const gateUrl = new URL('tests/contract/WP-002/gate-wiring.test.ts', root);
  const gate = readFileSync(gateUrl, 'utf8').replace(
    /const expectedSha = '[0-9a-f]{64}';/u,
    `const expectedSha = '${digest}';`,
  );
  writeFileSync(gateUrl, gate);
  process.stdout.write(`Adopted OpenAPI v${version} at ${digest}\n`);
} else {
  process.stderr.write('Usage: generate-openapi.ts --stdout | --adopt\n');
  process.exitCode = 1;
}
