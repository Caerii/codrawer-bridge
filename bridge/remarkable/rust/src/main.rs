//! codrawer_bridge_rs: the Paper Pro pen + keyboard bridge, optionally hosting the stroke router.
//! Drop-in for `codrawer_bridge_native` (same flags, env vars and log prefixes).

use codrawer_bridge::flags::{self, Config, FlagExit};
use codrawer_bridge::{bridge, router};

fn main() {
    let mut args = std::env::args();
    let prog = args.next().unwrap_or_else(|| "codrawer_bridge_rs".into());
    let args: Vec<String> = args.collect();
    if args.first().map(String::as_str) == Some("release") {
        std::process::exit(codrawer_bridge::release::run_release(&args[1..]));
    }

    let defaults = Config::from_env();
    let mut cfg = defaults.clone();
    match flags::parse_args(&mut cfg, &args) {
        Ok(()) => {}
        Err(FlagExit::Help) => {
            eprint!("{}", flags::usage(&prog, &defaults));
            std::process::exit(0);
        }
        Err(FlagExit::Error(e)) => {
            eprintln!("{e}");
            eprint!("{}", flags::usage(&prog, &defaults));
            std::process::exit(2);
        }
    }

    // A safe one-off check on the tablet: read the open page, print its message, touch nothing.
    if cfg.page_dump {
        match codrawer_bridge::page_watch::dump(&cfg.xochitl_dir) {
            Ok(msg) => println!("{msg}"),
            Err(e) => {
                eprintln!("page-dump: {e} (no page found)");
                std::process::exit(1);
            }
        }
        return;
    }

    // One thread runs the sockets; the pen, keyboard and typer get their own blocking threads.
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");

    rt.block_on(async move {
        if !cfg.serve_addr.is_empty() {
            let addr = cfg.serve_addr.clone();
            tokio::spawn(async move {
                // A failed listen is fatal: the glasses app would otherwise have nothing to connect to.
                println!("[router] listening on {addr}");
                let r = match router::bind(&addr).await {
                    Ok(l) => {
                        router::Router::new()
                            // pairing code for clients off the tablet (bridge.env)
                            .with_token(&std::env::var("ROUTER_TOKEN").unwrap_or_default())
                            // what boot.sh derived for this boot (/run/codrawer/env → the service's environment)
                            .with_info(router::host_info(|k| std::env::var(k).ok()))
                            .serve(l)
                            .await
                    }
                    Err(e) => Err(e),
                };
                if let Err(e) = r {
                    eprintln!("fatal: router: listen tcp {addr}: {e}");
                    std::process::exit(1);
                }
            });
        }
        if cfg.router_only {
            if cfg.serve_addr.is_empty() {
                eprintln!("fatal: -router-only needs -serve");
                std::process::exit(1);
            }
            std::future::pending::<()>().await;
        }
        if let Err(e) = bridge::run_bridge_forever(cfg).await {
            eprintln!("fatal: {e}");
            std::process::exit(1);
        }
    });
}
