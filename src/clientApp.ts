#!/usr/bin/env node
import { ArgumentParser } from 'argparse';
import { createReadStream, existsSync, promises as fs } from 'fs';
import httpProxy from 'http-proxy';
import jsBeautify from 'js-beautify';
import JSZip from 'jszip';
import Koa from 'koa';
import views from '@ladjs/koa-views';
import koaConditionalGet from 'koa-conditional-get';
import fetch from 'node-fetch';
import path from 'path';
import { Transform } from 'stream';
import { fileURLToPath, URL } from 'url';
import chalk from 'chalk';
import { getScreepsPath } from './utils/steamGamePath';
import { removeRoomDecorations, clientStartup, generateScriptTag } from './utils/clientScripts';
import { Server } from './utils/types';
import { ClientPath } from './utils/clientPath';

// Log welcome message
console.log('🧩', chalk.yellowBright('Screepers Steamless Client'));

// Parse program arguments
const argv = (function () {
    const parser = new ArgumentParser();
    parser.add_argument('--beautify', {
        action: 'store_true',
        default: false,
    });
    parser.add_argument('--package', {
        nargs: '?',
        type: 'str',
    });
    parser.add_argument('--port', {
        nargs: '?',
        type: 'int',
    });
    parser.add_argument('--backend', {
        nargs: '?',
        type: 'str',
    });
    parser.add_argument('--host', {
        nargs: '?',
        type: 'str',
    });
    parser.add_argument('--internal_backend', {
        nargs: '?',
        type: 'str',
    });
    parser.add_argument('--server_list', {
        nargs: '?',
        type: 'str',
    });
    return parser.parse_args();
})();

export const error = (...args: unknown[]) => console.error('❌', chalk.bold.red('Error'), ...args);

// Create proxy
const proxy = httpProxy.createProxyServer({ changeOrigin: true });
proxy.on('error', (err) => error(err));

const exitOnPackageError = () => {
    error('Could not find the Screeps "package.nw".');
    error('Use the "--package" argument to specify the path to the "package.nw" file.');
    process.exit(1);
};

// Locate and read `package.nw`
const readPackageData = async () => {
    const pkgPath = argv.package ?? (await getScreepsPath());
    if (!pkgPath || !existsSync(pkgPath)) exitOnPackageError();
    console.log('📦', chalk.dim('Package >'), chalk.gray(pkgPath));
    return Promise.all([fs.readFile(pkgPath), fs.stat(pkgPath)]).catch(exitOnPackageError);
};

const [data, stat] = await readPackageData();

// Read package zip metadata
const zip = new JSZip();
await zip.loadAsync(data);

// HTTP header is only accurate to the minute
const lastModified = stat.mtime;

// Set up koa server
const koa = new Koa();
const port = argv.port ?? 8080;
const host = argv.host ?? 'localhost';
const server = koa.listen(port, host);
server.on('error', (err) => error(err));

// Extract backend and endpoint from URL
const extract = (url: string) => {
    if (argv.backend) {
        return {
            backend: argv.backend.replace(/\/+$/, ''),
            endpoint: url,
        };
    }
    const groups = /^\/\((?<backend>[^)]+)\)(?<endpoint>\/.*)$/.exec(url)?.groups;
    if (groups) {
        return {
            backend: groups.backend.replace(/\/+$/, ''),
            endpoint: groups.endpoint,
        };
    }
};

// Get system path for public files dir
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const indexFile = 'index.ejs';

const getServerListConfig = async () => {
    let serverListPath = argv.server_list;
    if (!serverListPath) {
        const serverListFile = 'server_list.json';
        serverListPath = path.join(__dirname, `../settings/${serverListFile}`);
        if (!existsSync(serverListPath)) {
            serverListPath = path.join(__dirname, serverListFile);
        }
    }

    const serverConfig: Server[] = JSON.parse(await fs.readFile(serverListPath, 'utf-8'));
    const serverTypes = Array.from(new Set(serverConfig.map((server) => server.type)));
    const serverList = serverTypes.map((type) => {
        const serversOfType = serverConfig
            .filter((server) => server.type === type)
            .map((server) => {
                const subdomain = host === 'localhost' && server.subdomain ? `${server.subdomain}.` : '';
                const { origin, pathname } = new URL(server.url);
                const urlpath = pathname.endsWith('/') ? pathname : `${pathname}/`;

                const url = `http://${subdomain}${host}:${port}/(${origin})${urlpath}`;
                const api = `http://${host}:${port}/(${origin})${urlpath}api/version`;
                return { ...server, url, api };
            });

        return {
            name: type.charAt(0).toUpperCase() + type.slice(1),
            logo: type === 'official' ? `http://${host}:${port}/(file)/logotype.svg` : undefined,
            servers: serversOfType,
        };
    });

    return serverList;
};

// Setup views for rendering ejs files
koa.use(views(path.join(__dirname, '../views'), { extension: 'ejs' }));

// Serve client assets directly from steam package
koa.use(koaConditionalGet());

// Render the index.ejs file and pass the serverList variable
koa.use(async (context, next) => {
    if (argv.backend) return next(); // Skip if backend is specified

    if (['/', 'index.html'].includes(context.path)) {
        const serverList = await getServerListConfig();
        if (serverList.length) {
            await context.render(indexFile, { serverList });
            return;
        }
    }

    return next();
});

// Public files to serve
const publicFiles = [
    { file: 'public/favicon.png', type: 'image/png' },
    { file: 'public/style.css', type: 'text/css' },
    { file: 'dist/serverStatus.js', type: 'text/javascript' },
];

// Serve public files
koa.use(async (context, next) => {
    if (argv.backend) return next(); // Skip if backend is specified

    const urlPath = context.path.substring(1);
    for (const { file, type } of publicFiles) {
        if (urlPath === file) {
            context.type = type;
            context.body = createReadStream(path.join(rootDir, file));
            return;
        }
    }

    return next();
});

// Serve client assets
koa.use(async (context, next) => {
    const info = extract(context.path);
    if (!info) {
        error('Unknown URL', chalk.dim(context.path));
        return;
    }

    // TODO: very first thing to do here is check if the request is the official server (screeps.com)
    // because we need to check if the first path in `info.endpoint` is a prefix such as "/season" or "/ptr"
    // and we can strip that out of the path before we compare for the file in the zip

    // If the `info.endpoint` does match a prefix, we should set a boolean flag to indicate that the prefix
    // should be included in the URL path in other cases in the middleware content replacers

    console.log('Debug >', info);

    const isOfficial = info.backend === 'https://screeps.com';
    const prefix = isOfficial ? info.endpoint.match(/^\/(season|ptr)/)?.[0] : undefined;

    const endpointFilePath = prefix ? info.endpoint.replace(prefix, '') : info.endpoint;
    const urlPath = endpointFilePath === '/' ? 'index.html' : endpointFilePath.substring(1);

    const file = zip.files[urlPath];
    if (!file) {
        return next();
    }

    // Check cached response based on zip file modification
    context.lastModified = lastModified;
    if (context.fresh) {
        return;
    }

    const clientPath = new ClientPath({ host, port, prefix, backend: argv.backend, server: info.backend });

    // Rewrite various payloads
    context.body = await (async function () {
        if (urlPath === 'index.html') {
            let body = await file.async('text');
            // Inject startup script
            const header = '<title>Screeps</title>';
            const replaceHeader = [
                header,
                generateScriptTag(clientStartup, { backend: info.backend }),
                generateScriptTag(removeRoomDecorations, { backend: info.backend }),
            ].join('\n');
            body = body.replace(header, replaceHeader);

            // Remove tracking pixels
            body = body.replace(
                /<script[^>]*>[^>]*xsolla[^>]*<\/script>/g,
                '<script>xnt = new Proxy(() => xnt, { get: () => xnt })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*facebook[^>]*<\/script>/g,
                '<script>fbq = new Proxy(() => fbq, { get: () => fbq })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*google[^>]*<\/script>/g,
                '<script>ga = new Proxy(() => ga, { get: () => ga })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*mxpnl[^>]*<\/script>/g,
                '<script>mixpanel = new Proxy(() => mixpanel, { get: () => mixpanel })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*twttr[^>]*<\/script>/g,
                '<script>twttr = new Proxy(() => twttr, { get: () => twttr })</script>',
            );
            body = body.replace(
                /<script[^>]*>[^>]*onRecaptchaLoad[^>]*<\/script>/g,
                '<script>function onRecaptchaLoad(){}</script>',
            );
            return body;
        } else if (urlPath === 'config.js') {
            const basePath = argv.backend ? '' : `/(${info.backend})`;
            const history = `${basePath}/room-history/`;
            const api = `${basePath}/api/`;
            const socket = `${basePath}/socket/`;

            // Screeps server config
            let text = await file.async('text');
            text = text.replace(/(API_URL = ')[^']*/, `$1${api}`);
            text = text.replace(/(HISTORY_URL = ')[^']*/, `$1${history}`);
            text = text.replace(/(WEBSOCKET_URL = ')[^']*/, `$1${socket}`);
            text = text.replace(/(PREFIX: )[^,]*/, `$1'season'`); // TODO: set this on seasonal or PTR servers (servers using a prefix in the URL path)
            return text;

            // Old method, overwrite the file
            // return `
            //     var HISTORY_URL = '${history}';
            //     var API_URL = '${api}';
            //     var WEBSOCKET_URL = '${socket}';
            //     var CONFIG = {
            //         API_URL: API_URL,
            //         HISTORY_URL: HISTORY_URL,
            //         WEBSOCKET_URL: WEBSOCKET_URL,
            //         PREFIX: '',
            //         IS_PTR: false,
            //         DEBUG: false,
            //         XSOLLA_SANDBOX: false,
            //     };
            // `;
        } else if (context.path.endsWith('.js')) {
            let text = await file.async('text');
            if (urlPath === 'build.min.js') {
                // Load backend info from underlying server
                const backend = new URL(info.backend);
                const version = await (async function () {
                    try {
                        const response = await fetch(`${argv.internal_backend ?? info.backend}/api/version`);
                        return JSON.parse(await response.text());
                    } catch (err) {}
                })();
                const officialLike =
                    version?.serverData?.features?.some(
                        (f: { name: string }) => f.name.toLowerCase() === 'official-like',
                    ) ?? false;
                const official = backend.hostname === 'screeps.com' || officialLike;

                // Look for server options payload in build information
                for (const match of text.matchAll(/\boptions=\{/g)) {
                    for (let i = match.index!; i < text.length; ++i) {
                        if (text.charAt(i) === '}') {
                            try {
                                const payload = text.substring(match.index!, i + 1);
                                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                                const holder = new Function(payload);
                                if (payload.includes('apiUrl')) {
                                    // Inject `host`, `port`, and `official`
                                    text = `${text.substring(0, i)},
                                        host: ${JSON.stringify(backend.hostname)},
                                        port: ${backend.port || '80'},
                                        official: ${official},
                                    } ${text.substring(i + 1)}`;
                                }
                                break;
                            } catch (err) {}
                        }
                    }
                }
                if (backend.hostname !== 'screeps.com') {
                    // Replace room-history URL
                    const historyUrl = clientPath.getRoomHistoryURL();
                    text = text.replace(
                        /http:\/\/"\+s\.options\.host\+":"\+s\.options\.port\+"\/room-history/g,
                        historyUrl,
                    );

                    // Replace official CDN with local assets
                    text = text.replace(/https:\/\/d3os7yery2usni\.cloudfront\.net/g, `${info.backend}/assets`);
                }
            } else if (urlPath.startsWith('app2/main.')) {
                const clientHost = clientPath.getHost();
                text = text.replace(/"screeps\.com"/g, `"${clientHost}"`);
                text = text.replace(/"screeps\.com\/season"/g, `"${clientHost}/season"`);
                text = text.replace(/"https:\/\/screeps\.com"/g, `"http://${clientHost}/#!/register"`);
            }
            return argv.beautify ? jsBeautify(text) : text;
        } else {
            // JSZip doesn't implement their read stream correctly and it causes EPIPE crashes. Pass it
            // through a no-op transform stream first to iron that out.
            const stream = new Transform();
            stream._transform = function (chunk, encoding, done) {
                this.push(chunk, encoding);
                done();
            };
            file.nodeStream().pipe(stream);
            return stream;
        }
    })();

    // Set content type
    context.set(
        'Content-Type',
        {
            '.css': 'text/css',
            '.html': 'text/html',
            '.js': 'text/javascript',
            '.map': 'application/json',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.ttf': 'font/ttf',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2',
        }[/\.[^.]+$/.exec(urlPath.toLowerCase())?.[0] ?? '.html']!,
    );

    // We can safely cache explicitly-versioned resources forever
    if (context.request.query.bust) {
        context.set('Cache-Control', 'public,max-age=31536000,immutable');
    }
});

// Proxy API requests to Screeps server
koa.use(async (context, next) => {
    if (context.header.upgrade) {
        context.respond = false;
        return;
    }

    const info = extract(context.url);
    if (info) {
        context.respond = false;
        context.req.url = info.endpoint;
        if (info.endpoint.startsWith('/api/auth')) {
            const returnUrl = encodeURIComponent(info.backend);
            const separator = info.endpoint.endsWith('?') ? '' : info.endpoint.includes('?') ? '&' : '?';
            context.req.url = `${info.endpoint}${separator}returnUrl=${returnUrl}`;
        }
        proxy.web(context.req, context.res, {
            target: argv.internal_backend ?? info.backend,
        });
        return;
    }
    return next();
});

// Proxy WebSocket requests
server.on('upgrade', (req, socket, head) => {
    const info = extract(req.url!);
    if (info && req.headers.upgrade?.toLowerCase() === 'websocket') {
        req.url = info.endpoint;
        proxy.ws(req, socket, head, {
            target: argv.internal_backend ?? info.backend,
        });
        socket.on('error', (err) => error(err));
    } else {
        socket.end();
    }
});

// Clean up on exit
const cleanup = () => process.exit(1);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => server.close());

// Log server information
console.log('🌐', chalk.dim('Ready >'), chalk.white(`http://${host}:${port}/`));
