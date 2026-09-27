# Security Policy

## Supported Versions

Security fixes are released for the latest 2.x version only. Version 1.x is no
longer supported: upgrade to 2.x to get fixes (see
[Upgrading from 1.x](README.md#upgrading-from-1x)).

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

We take the security of lua-redis-wasm seriously. If you discover a security vulnerability, please follow these steps:

### Please Do Not

- **Do not** open a public GitHub issue for security vulnerabilities
- **Do not** disclose the vulnerability publicly until it has been addressed

### Please Do

1. **Report privately** through GitHub's private vulnerability reporting: open the
   repository's **Security** tab and click **Report a vulnerability**, or go
   directly to <https://github.com/fatal10110/lua-redis-wasm/security/advisories/new>.
2. **Include** as much information as possible:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)
3. **Allow** us reasonable time to address the issue before public disclosure

### What to Expect

- **Acknowledgment**: We will acknowledge receipt of your report within 48 hours
- **Updates**: We will provide regular updates on our progress
- **Timeline**: We aim to address critical vulnerabilities within 7 days
- **Credit**: With your permission, we will credit you in the security advisory

## Security Considerations

### Resource Limits

lua-redis-wasm includes resource limits to protect against:

- **Runaway scripts**: Fuel-based instruction limiting (on by default: 10,000,000
  instructions per script, which `pcall` cannot catch)
- **Memory exhaustion**: A fixed-size 64 MB WASM heap per engine
- **Large payloads**: Reply and argument size limits (off unless configured)

See [docs/limits.md](docs/limits.md) for the details and known gaps.

Always configure appropriate limits for your use case:

```typescript
const engine = await LuaEngine.create({
  host,
  limits: {
    maxFuel: 10_000_000,              // Instruction budget
    maxReplyBytes: 2 * 1024 * 1024,   // 2 MB
    maxArgBytes: 1 * 1024 * 1024      // 1 MB
  }
});
```

### Untrusted Scripts

When executing untrusted Lua scripts:

1. **Always** set resource limits
2. **Validate** host callback inputs
3. **Sanitize** data returned from host callbacks
4. **Isolate** engines per-user or per-request, and `dispose()` them when done
5. **Monitor** execution time and resource usage (the fuel budget counts Lua
   instructions, not time spent in host callbacks or C functions)
6. **Recreate** an engine that throws `WasmFault` or `LuaEngine is unusable`
   (see [docs/errors.md](docs/errors.md#exceptions-thrown-by-the-engine))

### Host Interface Security

The host interface allows Lua scripts to call back into JavaScript:

- **Validate** all arguments from Lua scripts
- **Sanitize** data before database/API calls
- **Implement** rate limiting for expensive operations
- **Log** suspicious activity
- **Never trust** script-provided data

Example secure host implementation:

```typescript
const engine = await LuaEngine.create({
  host: {
    redisCall(args) {
      // Validate command allowlist
      const cmd = args[0]?.toString().toUpperCase() ?? '';
      const allowedCommands = ['GET', 'SET', 'PING'];

      if (!allowedCommands.includes(cmd)) {
        return { err: Buffer.from('ERR command not allowed') };
      }

      // Implement actual logic with proper validation
      return null;
    },
    redisPcall(args, ctx) {
      return this.redisCall(args, ctx);
    },
    log(level, message) {
      // Sanitize log messages
      const safeMessage = message.toString().slice(0, 1000);
      console.log(`[${level}] ${safeMessage}`);
    }
  }
});
```

### Dependencies

We regularly update dependencies to address security vulnerabilities:

- Check for updates: `npm audit`
- Update dependencies: `npm update`
- Review security advisories on GitHub

## Known Limitations

- **Sandboxing**: While WASM provides isolation, it's not a complete security sandbox
- **Fuel gap**: work spread over many coroutines that each finish within 1000
  instructions is not charged against `maxFuel` (#75)
- **Side channels**: Timing attacks may be possible
- **Resource monitoring**: Host is responsible for monitoring overall system resources

## Security Updates

Security updates will be published as:

1. **GitHub Security Advisories**
2. **npm advisories**
3. **CHANGELOG.md** entries marked as `[SECURITY]`

Subscribe to releases and security advisories to stay informed.

## Best Practices

### For Library Users

- Keep lua-redis-wasm updated to the latest version
- Configure resource limits appropriate for your use case
- Validate all inputs to host callbacks
- Isolate engines for untrusted scripts
- Monitor resource usage in production

### For Contributors

- Follow secure coding practices
- Avoid introducing dependencies with known vulnerabilities
- Add tests for security-sensitive code
- Document security implications of changes

## Questions?

For general security questions (not vulnerabilities), you can:

- Open a [GitHub issue](https://github.com/fatal10110/lua-redis-wasm/issues)
- Email: gh.public10110@gmail.com

Thank you for helping keep lua-redis-wasm secure!
