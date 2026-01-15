# Contributing to lua-redis-wasm

Thank you for your interest in contributing to lua-redis-wasm! We welcome contributions from the community.

## Code of Conduct

This project adheres to a Code of Conduct. By participating, you are expected to uphold this code. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing.

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates. When creating a bug report, include:

- **Clear title and description**
- **Steps to reproduce** the issue
- **Expected behavior** vs actual behavior
- **Code samples** or test cases
- **Environment details** (Node.js version, OS)
- **Error messages** or stack traces

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, include:

- **Clear title and description**
- **Use case** explaining why this would be useful
- **Examples** of how the feature would be used
- **Alternatives considered**

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Follow the development setup** instructions below
3. **Make your changes** with clear commit messages
4. **Add tests** for new functionality
5. **Update documentation** if needed
6. **Ensure all tests pass** with `npm test`
7. **Submit a pull request** with a clear description

## Development Setup

### Prerequisites

- Node.js >= 22
- Docker (for building WASM)
- Git with submodule support

### Setup Instructions

```bash
# Clone the repository with submodules
git clone --recursive https://github.com/fatal10110/lua-redis-wasm.git
cd lua-redis-wasm

# Install dependencies
npm install

# Build WASM (requires Docker)
npm run build:wasm

# Build TypeScript
npm run build:ts

# Run tests
npm test
```

### Project Structure

```
lua-redis-wasm/
├── src/           # TypeScript source files
├── wasm/          # C source and build scripts
├── test/          # Test files
├── docs/          # Documentation
└── dist/          # Compiled output (generated)
```

### Build Commands

- `npm run build` - Full build (WASM + TypeScript)
- `npm run build:wasm` - Build WASM only (uses Docker)
- `npm run build:ts` - Build TypeScript only
- `npm test` - Run all tests
- `npm run test:skip-wasm` - Run tests without rebuilding WASM

## Coding Standards

### TypeScript

- Use **TypeScript strict mode**
- Follow **existing code style** (check `.editorconfig` if present)
- Use **meaningful variable names**
- Add **JSDoc comments** for public APIs
- Avoid `any` types where possible

### C Code

- Follow **Redis code style** for consistency
- Add **comments** for complex logic
- Ensure **memory safety** (no leaks, buffer overflows)
- Test with **smoke tests** in `wasm/src/tests/`

### Commit Messages

- Use **present tense** ("Add feature" not "Added feature")
- Use **imperative mood** ("Move cursor to..." not "Moves cursor to...")
- **First line** should be 50 chars or less
- **Reference issues** when applicable (#123)

Examples:
```
Add support for redis.sha1hex command

Fix memory leak in reply buffer allocation

Update documentation for host interface
```

## Testing

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
node --test --import tsx test/engine.test.ts

# Run with coverage (if configured)
npm run test:coverage
```

### Writing Tests

- Place tests in `test/` directory with `.test.ts` extension
- Use Node.js built-in test runner
- Test both success and error cases
- Include edge cases (null bytes, large inputs, limits)
- Add conformance tests for Redis compatibility

Example:
```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { LuaWasmEngine } from '../src/index.js';

test('description of test', async () => {
  const engine = await LuaWasmEngine.createStandalone();
  const result = engine.eval('return 1 + 1');
  assert.strictEqual(result, 2);
});
```

## Documentation

- Update **README.md** for user-facing changes
- Update **docs/** for technical details
- Add **JSDoc comments** for new public APIs
- Update **CHANGELOG.md** following [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

## Security

If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md). Do not open a public issue.

## Questions?

Feel free to open a discussion or issue for any questions about contributing!

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
