# Read the code

This is plain JavaScript, HTML, and CSS. Node runs the files you see here directly.
There is no bundle, minification, obfuscation, transpilation, framework, runtime
package dependency, analytics, or remotely loaded script. The only browser page
in the working application is the local sign-in form; it needs no JavaScript.

## Start here

Read [src/enroll.js](src/enroll.js) first. Its four numbered steps describe the
whole account enrollment operation. Then follow the functions it calls:

| File | Responsibility |
| --- | --- |
| [bin/bna.js](bin/bna.js) | Start the command-line tool. |
| [src/cli.js](src/cli.js) | Parse commands, print results, handle Ctrl-C. |
| [src/enroll.js](src/enroll.js) | Coordinate login, one enrollment request, recovery, and config. |
| [src/browser-login.js](src/browser-login.js) | Receive a pasted login token on a temporary loopback server. |
| [src/open-browser.js](src/open-browser.js) | Open the default browser on Windows, WSL, macOS, or Linux. |
| [web/login.html](web/login.html) | The sign-in form and instructions. |
| [web/received.html](web/received.html) | Acknowledge receipt of the login token. |
| [web/login.css](web/login.css) | Styles shared by both pages. |
| [src/login-page.js](src/login-page.js) | Read those files, escape inserted text, and assemble each page. |
| [src/modern.js](src/modern.js) | Exchange the login token and attach an authenticator over HTTPS. |
| [src/config.js](src/config.js) | Read and write the Python-compatible INI file. |
| [src/totp.js](src/totp.js) | Generate the eight-digit code locally. |
| [src/base32.js](src/base32.js) | Convert between binary secrets and Base32 text. |
| [src/utils.js](src/utils.js) | Normalize serials and create the OTPAuth setup URL. |
| [src/http.js](src/http.js) | Original binary enrollment, restore, and time API. |
| [src/crypto.js](src/crypto.js) | Original restore-code and raw RSA protocol operations. |
| [src/constants.js](src/constants.js) | Public parameters for the original protocol. |
| [src/index.js](src/index.js) | Library exports. |
| [test/](test/) | Public/synthetic fixtures and offline regression tests. |

The name `decrypt` in the legacy protocol means XOR with a random one-time pad.
That pad is different from the one-time password entered during login. The large
RSA number and the mobile client identifier are public protocol parameters.
They are not hidden credentials or obfuscated code.

## Follow the data

1. `bna enroll` reserves a recovery file, starts a server on `127.0.0.1` using an
   available port and a random path, and opens that local page.
2. The user follows its link to Battle.net and enters their password there.
   This application has no password field for the Battle.net password.
3. The user pastes the final address back into the local form. `parseSsoInput`
   extracts its `ST` login token. A 404 at the final Battle.net address can be
   expected: the address itself still contains the token.
4. `exchangeSsoToken` sends that token to `https://oauth.battle.net/oauth/sso`
   with the public mobile client identifier and `auth.authenticator` scope.
   The returned access token stays in process memory.
5. `enroll` sends the access token to
   `https://authenticator-rest-api.bnet-identity.blizzard.net/v1/authenticator`.
   **This request changes the account by attaching an authenticator.**
6. The successful JSON response is written to a recovery file before validation.
   The validated secret and restore code are then written to the config file.
7. `bna show-url` reads the local config and prints an OTPAuth setup URL. The user
   copies it into 1Password. This application does not contact 1Password.
8. `bna show` computes codes from the secret and the local clock without networking.

The browser page embeds the local CSS file so its receipt page still works after
its temporary server closes. Its content policy permits that CSS, blocks scripts
and external assets, and restricts form submission to the same origin. The login
server also checks the exact Host, Origin, path, method, and form size.

## Where sensitive data lives

| Data | Destination and lifetime |
| --- | --- |
| Battle.net password | Entered only on Battle.net's website. |
| Pasted redirect address / login token | Local form and Node process; token sent to Battle.net's SSO endpoint. Not intentionally logged or saved by this program. The browser can retain the original address in history. |
| Access token | Node process memory; sent only to the enrollment endpoint by this flow. Not intentionally logged or saved. |
| Authenticator secret and restore code | Local INI config and successful-response recovery JSON. Both are unencrypted. |
| OTPAuth setup URL | Printed only by `show-url`; includes the secret. Copying it puts it on the clipboard, and saving it stores it in the chosen OTP provider. |
| Eight-digit code | Computed locally and printed by `show`. |

JavaScript strings are not securely erased from memory. Ending the process ends
its use of the tokens; the code does not promise immediate memory zeroization.
File creation requests mode `0600` and private directories where POSIX permissions
apply. Windows permissions depend on the containing filesystem and account.

The recovery file is reserved before enrollment. A successful response is written
and flushed before updating the normal config. If config saving fails, the backup
is retained. A partial backup is also retained if writing the recovery data fails.
Network failures or responses that cannot be read as JSON may leave the remote
outcome unknown: the program does not automatically retry enrollment. Check the
account state before trying another attachment.

`bna delete` removes an entry from the local config only. It does not detach an
authenticator from Battle.net or remove an existing recovery backup.

## Downloaded or hosted online?

| Model | What would run where? | Current state |
| --- | --- | --- |
| Download and run locally | Node runs on the user's computer; the browser opens its local UI. | Implemented. Requires Node 22+. A one-click desktop launcher is not included yet. |
| Self-host on your own server | Node runs on a machine you control; it handles and saves the secrets there. | Would require adapting this CLI and loopback session into a server application. |
| Public hosted service | A shared backend exchanges users' tokens and receives their new secrets. | Not implemented. Needs isolated user sessions, HTTPS, recovery/export handling, and an explicit storage policy. |
| Static browser-only website | All token exchange and secret processing would run in each user's browser. | Not verified. The current code uses Node APIs; Battle.net's cross-origin and redirect behavior would also need testing. |

Uploading the HTML files to a static host does not run the Node enrollment flow.
Exposing the current loopback server on a public interface does not turn it into
a multi-user service: it accepts one session and exits after receiving its token.

For a public service, publishing readable code helps people review it, but does
not prove that a deployed server runs that exact code or keeps no additional logs.
A local distribution lets people run the reviewed source on their own machine.

This source release implements browser-assisted CLI enrollment. A complete
four-step web wizard remains a design prototype and is not included here.

## Keep it readable

- Run source files directly; distribute the same source files.
- Use descriptive names and straightforward control flow.
- Explain protocol formats, units, and irreversible steps next to the code.
- Keep HTML and CSS separate from HTTP and credential handling.
- Keep all outbound endpoints visible in the protocol clients.
- Never put real account credentials in examples, tests, or release archives.
- Keep tests offline; use `fetchImpl` and the enrollment callbacks for substitutes.

`.editorconfig` sets two-space indentation. `.prettierrc.json` records formatting
preferences for editors that already use Prettier. Formatting is optional tooling,
not a required installation or build step.
