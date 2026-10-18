import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { describe, test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./extension.mjs", import.meta.url), "utf8");

async function loadExtension(output, overrides = {}) {
    // El SDK lo inyecta Copilot; las pruebas ejecutan el proveedor sin una sesión.
    return runInNewContext(
        `(async () => {
            ${source.replace(/^import .*;\r?$/gm, "")}
            return { profiles, solutions, azureAccounts, authentication, roles, startServer, HTML };
        })()`,
        {
            joinSession: async () => {},
            createCanvas: (canvas) => canvas,
            execFile: (cmd, args, options, callback) => callback(null, output, ""),
            process: { platform: "darwin" },
            createServer,
            URL,
            ...overrides,
        },
    );
}

function table(columns, values) {
    return `${columns.map((column) => column.padEnd(32)).join("")}\n${values.map((value) => value.padEnd(32)).join("")}\n`;
}

for (const includeErp of [false, true]) {
    test(`perfiles PAC ${includeErp ? "con" : "sin"} ERP URL conservan la URL completa`, async () => {
        const columns = ["Index", "Active", "Kind", "Name", "User", "Cloud", "Type", "Environment", "Environment Url"];
        const values = ["[1]", "*", "UNIVERSAL", "Demo profile", "test@example.invalid", "Public", "User", "Demo environment", "https://demo.crm.dynamics.com/"];
        if (includeErp) {
            columns.push("ERP URL");
            values.push("https://erp.example.invalid/");
        }
        const extension = await loadExtension(table(columns, values));
        const profiles = await extension.profiles();
        assert.equal(profiles.length, 1);
        assert.equal(profiles[0].index, 1);
        assert.equal(profiles[0].active, true);
        assert.equal(profiles[0].name, "Demo profile");
        assert.equal(profiles[0].environment, "Demo environment");
        assert.equal(profiles[0].url, "https://demo.crm.dynamics.com");
    });
}

describe("Autenticación de Azure y acceso a Dataverse", () => {
    const profile = { user: "test@example.invalid", url: "https://demo.crm.dynamics.com" };

    function azureSession({ user = profile.user, error, token = "test-access-token", onToken = () => {} } = {}) {
        return (cmd, args, options, callback) => {
            assert.equal(cmd, "az");
            assert.equal(options.shell, false);
            if (error) return callback(new Error(error), "", error);
            if (args[1] === "get-access-token") onToken(args);
            callback(null, args[1] === "list"
                ? JSON.stringify([{ id: "test-subscription", name: "Test", state: "Enabled", user: { name: user }, tenantId: "test-tenant", isDefault: true }])
                : token, "");
        };
    }

    test("valida Azure con WhoAmI y avisa de cuentas distintas sin bloquear alias", async () => {
        const extension = await loadExtension("", {
            execFile: azureSession({ user: "alias@example.invalid" }),
            fetch: async (url, options) => {
                assert.equal(url, `${profile.url}/api/data/v9.2/WhoAmI`);
                assert.equal(options.headers.Authorization, "Bearer test-access-token");
                return { ok: true, json: async () => ({ UserId: "test-user", OrganizationId: "test-org" }) };
            },
        });
        const auth = await extension.authentication(profile, "test-subscription");
        assert.equal(auth.azureUser, "alias@example.invalid");
        assert.equal(auth.tenant, "test-tenant");
        assert.match(auth.warning, /distintos/);
    });

    test("sin sesión Azure indica cómo iniciar sesión con la cuenta PAC", async () => {
        const extension = await loadExtension("", { execFile: azureSession({ error: "Please run az login" }) });
        await assert.rejects(extension.authentication(profile, "test-subscription"), /az login --allow-no-subscriptions/);
    });

    test("un 403 detiene los roles antes de consultar metadatos y explica ambas identidades", async () => {
        const calls = [];
        const extension = await loadExtension("", {
            execFile: azureSession(),
            fetch: async (url) => {
                calls.push(url);
                return { ok: false, status: 403, text: async () => "The user is not a member of the organization." };
            },
        });
        await assert.rejects(extension.roles(profile, "demo", "test-subscription"), (error) => {
            assert.match(error.message, /PAC: test@example.invalid/);
            assert.match(error.message, /Azure CLI: test@example.invalid; tenant: test-tenant/);
            assert.match(error.message, /az login --tenant <tenant-del-entorno>/);
            assert.match(error.message, /403.*not a member/);
            return true;
        });
        assert.deepEqual(calls, [`${profile.url}/api/data/v9.2/WhoAmI`]);
    });

    test("rechaza un token vacío sin consultar Dataverse", async () => {
        const extension = await loadExtension("", {
            execFile: azureSession({ token: "" }),
            fetch: async () => assert.fail("No debe consultar Dataverse sin token"),
        });
        await assert.rejects(extension.authentication(profile, "test-subscription"), /token vacío/);
    });

    test("el endpoint de autenticación no expone el token y conserva la URL del perfil", async () => {
        const profiles = table(
            ["Index", "Active", "Kind", "Name", "User", "Cloud", "Type", "Environment", "Environment Url"],
            ["[1]", "*", "UNIVERSAL", "Demo", profile.user, "Public", "User", "Demo", profile.url],
        );
        const extension = await loadExtension("", {
            execFile: (cmd, args, options, callback) => cmd === "pac"
                ? callback(null, profiles, "")
                : azureSession()(cmd, args, options, callback),
            fetch: async () => ({ ok: true, json: async () => ({ UserId: "test-user", OrganizationId: "test-org" }) }),
        });
        const { server, url } = await extension.startServer();
        try {
            const response = await fetch(new URL("/auth?index=1&azure=test-subscription", url));
            assert.equal(response.status, 200);
            const body = await response.text();
            assert.ok(!body.includes("test-access-token"));
            const auth = JSON.parse(body);
            assert.equal(auth.pacUser, profile.user);
            assert.equal(auth.warning, "");
            const accounts = await (await fetch(new URL("/azure-accounts", url))).json();
            assert.equal(accounts[0].id, "test-subscription");
            const missing = await fetch(new URL("/auth?index=1", url));
            assert.equal(missing.status, 400);
            assert.match((await missing.json()).error, /Selecciona una cuenta/);
            const invalid = await fetch(new URL("/auth?index=invalid", url));
            assert.equal(invalid.status, 400);
            assert.match((await invalid.json()).error, /perfil PAC/);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    test("el script de la canvas compila", async () => {
        const { HTML } = await loadExtension("");
        const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
        assert.doesNotThrow(() => new Function(script));
    });

    test("selecciona el contexto Azure explícito sin cambiar la cuenta predeterminada", async () => {
        let tokenArgs;
        const extension = await loadExtension("", {
            execFile: azureSession({ onToken: (args) => { tokenArgs = args; } }),
            fetch: async () => ({ ok: true, json: async () => ({ UserId: "test-user", OrganizationId: "test-org" }) }),
        });
        await extension.authentication(profile, "test-subscription");
        assert.equal(tokenArgs[tokenArgs.indexOf("--subscription") + 1], "test-subscription");
        assert.equal(tokenArgs[tokenArgs.indexOf("--resource") + 1], profile.url);
        assert.ok(!tokenArgs.includes("--tenant"));
    });

    test("rechaza una selección eliminada sin usar por defecto otra cuenta", async () => {
        const extension = await loadExtension("", {
            execFile: azureSession({ onToken: () => assert.fail("No debe obtener un token de otra cuenta") }),
        });
        await assert.rejects(extension.authentication(profile, "removed"), /ya no está disponible/);
    });
});

test("agrupa suscripciones por cuenta y tenant conservando el contexto predeterminado", async () => {
    const entry = { state: "Enabled", user: { name: "test@example.invalid" }, tenantId: "tenant-a" };
    const extension = await loadExtension(JSON.stringify([
        { ...entry, id: "sub-1", name: "One" },
        { ...entry, id: "sub-2", name: "Two", isDefault: true },
        { ...entry, id: "tenant-only", tenantId: "tenant-b", name: "Tenant account" },
        { ...entry, id: "other-user", user: { name: "other@example.invalid" } },
        { ...entry, id: "disabled", tenantId: "disabled-tenant", state: "Disabled" },
    ]));
    const accounts = await extension.azureAccounts();
    assert.equal(accounts.length, 3);
    assert.equal(accounts[0].id, "sub-2");
    assert.equal(accounts[0].active, true);
    assert.equal(accounts[1].id, "tenant-only");
    assert.equal(accounts[2].user, "other@example.invalid");
});

test("sin cuentas Azure indica iniciar sesión y actualizar la lista", async () => {
    const extension = await loadExtension("[]");
    await assert.rejects(extension.azureAccounts(), /az login.*Actualizar cuentas Azure/);
});

test("los dos selectores llegan a las consultas y cambiar Azure invalida respuestas antiguas", async () => {
    const { HTML } = await loadExtension("");
    const script = HTML.match(/<script>([\s\S]*?)<\/script>/)[1].replace("init();", "");
    const elements = new Map();
    const requests = [];
    let releaseRoles;
    let delayRoles = false;
    const document = { getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { value: "", textContent: "", disabled: false });
        return elements.get(id);
    } };
    await runInNewContext(`(async()=>{
        ${script}
        profs=[{index:2,user:'pac@example.invalid'}];
        $('prof').value='2';$('azure').value='azure-a';$('sol').value='demo';
        assert.equal(await checkAccess(),true);
        await loadRoles(true);
        assert.equal($('out').textContent,'La solución no contiene roles de seguridad.');
        startDelay();
        const pending=loadRoles(true);
        $('azure').value='azure-b';
        await $('azure').onchange();
        release();
        await pending;
        assert.equal($('auth').textContent.includes('azure-b@example.invalid'),true);
        assert.equal($('out').textContent,'La solución no contiene roles de seguridad.');
        $('azure').value='';
        await $('azure').onchange();
        assert.equal($('refresh').disabled,true);
        assert.equal($('tfilter').disabled,true);
        assert.equal($('checkauth').disabled,true);
        assert.equal($('out').textContent,'');
    })()`, {
        document, assert,
        startDelay: () => { delayRoles = true; },
        release: () => releaseRoles(),
        fetch: async (path) => {
            const url = new URL(path, "http://127.0.0.1");
            requests.push(url);
            assert.equal(url.searchParams.get("index"), "2");
            if (url.pathname === "/auth") return { json: async () => ({
                pacUser: "pac@example.invalid",
                azureUser: `${url.searchParams.get("azure")}@example.invalid`,
                tenant: "test-tenant",
            }) };
            assert.equal(url.pathname, "/roles");
            assert.equal(url.searchParams.get("solution"), "demo");
            if (delayRoles && url.searchParams.get("azure") === "azure-a") {
                return new Promise((resolve) => { releaseRoles = () => resolve({ json: async () => ({ roles: [{ name: "Stale" }] }) }); });
            }
            return { json: async () => ({ roles: [] }) };
        },
    });
    assert.ok(requests.some((url) => url.pathname === "/roles" && url.searchParams.get("azure") === "azure-b"));
});

test("las soluciones conservan sus nombres y propiedades", async () => {
    const extension = await loadExtension(table(
        ["Unique Name", "Friendly Name", "Version", "Managed"],
        ["demo_solution", "Demo solution", "1.2.3.4", "True"],
    ));
    const solutions = await extension.solutions("https://demo.crm.dynamics.com");
    assert.equal(solutions.length, 1);
    assert.equal(solutions[0].unique, "demo_solution");
    assert.equal(solutions[0].friendly, "Demo solution");
    assert.equal(solutions[0].version, "1.2.3.4");
    assert.equal(solutions[0].managed, true);
});
