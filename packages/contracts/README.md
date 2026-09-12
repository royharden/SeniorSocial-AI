# Runtime contracts

This package exposes one primary schema set through `schemas`, the shared ride and
assistance `requestStatusVocabulary`, and `validateInput` for a fixed 422 problem
response without raw validation issues. The gateway declarations and audit JSON
Schema are also available as package subpath exports.

`src/definitions.json` is the primary schema definition set. `src/schema.ts`
compiles it into Zod validators, including closed objects, UUID/date-time/email
formats, collection uniqueness, bounds and nullable fields. Unsupported keywords,
formats and misplaced constraints throw during compilation. Open dictionaries
stay open where the contract leaves their contents unspecified. Authentication,
organization scoping and authorization still belong to route/policy code.

`generateOpenApiDocument()` derives schema facets from those live validators with
Zod's JSON Schema conversion. The adapter preserves reference names, annotations,
required-field ordering and equivalent JSON Schema representations. The custom
`uniqueItems` output describes the same structural-equality check used at runtime.
It does not emit a separate peer schema catalogue.

`src/document.json` contains the non-schema API document. `src/presentation.json`
contains the adopted formatting with every schema scalar replaced by a slot.
`generateOpenApiYaml()` fills those slots from the generated document and verifies
the resulting YAML parses back to that document. A structural change or a scalar
requiring different quoting uses ordinary YAML serialization instead. Changing
validator constraints therefore changes generated output; no frozen interface file
is read at runtime.

The package exports TypeScript source for the workspace toolchain. Run the
independently authored contract, unit and security tests through the workspace
runner after integration. The package itself does not own test or root runner
configuration.

Named DTO types and the `ContractTypes` map are generated from the live validators
by `pnpm exec tsx packages/contracts/scripts/generate-types.ts`
from the workspace coding root. They describe structural types; runtime validation
still enforces formats, lengths, collection bounds and uniqueness.

Run `pnpm --filter @seniorsocial/contracts run generate:openapi -- --stdout` to
emit the live OpenAPI document. Both generators are TypeScript scripts included
in the package's shared strict typecheck and full-package lint checks.
