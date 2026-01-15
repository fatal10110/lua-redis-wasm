# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of lua-redis-wasm seriously. If you discover a security vulnerability, please follow these steps:

### Please Do Not

- **Do not** open a public GitHub issue for security vulnerabilities
- **Do not** disclose the vulnerability publicly until it has been addressed

### Please Do

1. **Email** security concerns to: [INSERT SECURITY EMAIL]
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

- **Runaway scripts**: Fuel-based instruction limiting
- **Memory exhaustion**: Memory growth caps
- **Large payloads**: Reply and argument size limits

Always configure appropriate limits for your use case:

```typescript
const engine = await LuaWasmEngine.create({
  host,
  limits: {
    maxFuel: 10_000_000,              // Instruction budget
    maxMemoryBytes: 64 * 1024 * 1024, // 64 MB
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
4. **Isolate** engines per-user or per-request
5. **Monitor** execution time and resource usage

### Host Interface Security

The host interface allows Lua scripts to call back into JavaScript:

- **Validate** all arguments from Lua scripts
- **Sanitize** data before database/API calls
- **Implement** rate limiting for expensive operations
- **Log** suspicious activity
- **Never trust** script-provided data

Example secure host implementation:

```typescript
const engine = await LuaWasmEngine.create({
  host: {
    redisCall(args) {
      // Validate command allowlist
      const cmd = args[0]?.toString();
      const allowedCommands = ['GET', 'SET', 'PING'];
      
      if (!allowedCommands.includes(cmd)) {
        return { err: Buffer.from('ERR command not allowed') };
      }
      
      // Implement actual logic with proper validation
      // ...
    },
    redisPcall(args) {
      return this.redisCall(args);
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
- **Side channels**: Timing attacks may be possible
- **Resource monitoring**: Host is responsible for monitoring overall system resources

## Security Updates

Security updates will be published as:

1. **GitHub Security Advisories**
2. **npm advisories**
3. **CHANGELOG.md** entries marked as [SECURITY]

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

- Open a GitHub Discussion
- Email: gh.public10110@gmail.com

Thank you for helping keep lua-redis-wasm secure!
