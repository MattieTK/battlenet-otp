# Battle.net OTP

Set up a Battle.net authenticator for **1Password or another compatible OTP provider**. Runs locally on your computer, with a browser page for sign-in.

![The local Battle.net setup page with its sign-in button](docs/images/setup.png)

## Install

Install [Node.js 22 or newer](https://nodejs.org/), then download and extract the repository using **Code → Download ZIP**, or clone it:

```sh
git clone https://github.com/MattieTK/battlenet-otp.git
cd battlenet-otp
```

Open a terminal in that folder. No dependencies or build step are required.

## Walkthrough

1. **Start setup.** Run:

   ```sh
   node bin/bna.js enroll
   ```

   The local page shown above opens in your browser. Keep the terminal running. This flow attaches a **new authenticator** to your account.

2. **Sign in to Battle.net.** Use the sign-in button. Your browser returns to **Sign-in received** on the local page. If it sends you to account management instead, return to setup and use **Didn't return here? → Sign out … and try again**. That section also offers manual sign-in if needed.

3. **Complete attachment.** Select **Continue and attach authenticator**. Wait for the terminal to confirm success and print the recovery-file location. Keep that file private and safe.

4. **Add it to 1Password.** Run:

   ```sh
   node bin/bna.js show-url
   ```

   Edit your Battle.net login in 1Password, add a **One-Time Password** field, and paste the complete URL. Save the item. The URL includes the required **eight-digit** setting; treat it like a password.

5. **Verify.** Compare the code in 1Password with:

   ```sh
   node bin/bna.js show
   ```

   Compare within the same 30-second interval, then test a Battle.net sign-in. Other providers must support **TOTP, SHA-1, eight digits, and a 30-second period**.

For WoW's extra backpack slots, [Blizzard also requires Battle.net Phone Notifications](https://worldofwarcraft.blizzard.com/en-us/news/23964689).

---

Independent project using a community-documented enrollment API. [Test results and limitations](TESTING.md) · [Read the code](ARCHITECTURE.md) · [Report a problem](https://github.com/MattieTK/battlenet-otp/issues)

Based on [python-bna](https://github.com/jleclanche/python-bna). [MIT license](LICENSE).
