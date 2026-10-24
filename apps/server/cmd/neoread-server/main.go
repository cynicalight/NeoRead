package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"log/slog"
	"neoread.local/server/internal/diagnostics"
	"neoread.local/server/internal/neoread"
	"neoread.local/server/internal/networkprobe"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
)

var neoreadVersion = "dev"
var buildCommit = "unknown"

func main() {
	data := flag.String("data", ".neoread", "local library directory")
	port := flag.String("port", "17840", "loopback port, 0 for automatic")
	web := flag.String("web", "", "built web directory")
	connector := flag.Bool("connector", true, "enable NeoRead Connector listener")
	citeCredential := flag.String("cite-credential", "", "credential file for the Word and WPS plugins")
	citePlugins := flag.String("cite-plugins", "", "directory with the Word and WPS add-in files")
	probeNetwork := flag.Bool("probe-network", false, "check ChatGPT reachability and exit without opening a library")
	logs := flag.String("logs", "", "diagnostic log directory")
	session := flag.String("session", "", "diagnostic session ID")
	migrateLibrary := flag.String("migrate-library", "", "copy a stopped library to a new directory and exit")
	legacySource := flag.String("migrate-reader-data", "", "migrate Reader application data once and exit")
	legacyCleanup := flag.String("cleanup-reader-data", "", "keep or delete the migrated Reader application data")
	legacyDirectory := flag.String("reader-data", "", "legacy application data directory for cleanup")
	shutdownOnStdin := flag.Bool("shutdown-on-stdin", false, "shut down when the desktop closes stdin")
	checkLibrary := flag.Bool("check-library", false, "validate an existing library and exit")
	flag.Parse()
	if *checkLibrary {
		if err := neoread.ValidateLibrary(*data); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *legacySource != "" || *legacyCleanup != "" {
		if *logs == "" {
			*logs = filepath.Join(*data, ".migration-logs")
		}
		recorder, _ := diagnostics.New(*logs, *session)
		slog.SetDefault(recorder.Logger())
		var state *neoread.ReaderMigration
		var err error
		if *legacySource != "" {
			state, err = neoread.MigrateReaderData(*legacySource, *data)
		} else {
			state, err = neoread.CleanupReaderData(*legacyDirectory, *data, *legacyCleanup)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err = json.NewEncoder(os.Stdout).Encode(state); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *migrateLibrary != "" {
		if err := neoread.CopyLibrary(*data, *migrateLibrary); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *probeNetwork {
		_ = json.NewEncoder(os.Stdout).Encode(networkprobe.Run(context.Background()))
		return
	}
	root, err := filepath.Abs(*data)
	if err != nil {
		log.Fatal(err)
	}
	if *logs == "" {
		*logs = filepath.Join(root, "logs")
	}
	recorder, logErr := diagnostics.New(*logs, *session, os.Getenv("NEOREAD_TOKEN"))
	if logErr == nil {
		slog.SetDefault(recorder.Logger())
	} else {
		log.Printf("local logging unavailable: %v", logErr)
	}
	recorder.Environment = map[string]any{"mode": "server", "appVersion": neoreadVersion, "buildCommit": buildCommit, "os": runtime.GOOS, "architecture": runtime.GOARCH, "goVersion": runtime.Version()}
	slog.Info("server.start", "appVersion", neoreadVersion, "buildCommit", buildCommit, "goVersion", runtime.Version())
	unlock, err := neoread.LockLibrary(root)
	if err != nil {
		log.Fatal(err)
	}
	defer unlock()
	store, err := neoread.OpenLibrary(root)
	if err != nil {
		log.Fatal(err)
	}
	defer store.DB.Close()
	token := os.Getenv("NEOREAD_TOKEN")
	if token == "" {
		b := make([]byte, 32)
		if _, err = rand.Read(b); err != nil {
			log.Fatal(err)
		}
		token = hex.EncodeToString(b)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:"+*port)
	if err != nil {
		log.Fatal(err)
	}
	recorder.Secrets = append(recorder.Secrets, token)
	server := neoread.NewServer(store, token, *web)
	server.SetDiagnostics(recorder)
	defer server.Close()
	if !*connector {
		server.SetConnectorUnavailable("disabled")
	} else {
		connectorListener, connectorError := net.Listen("tcp", "127.0.0.1:"+neoread.ConnectorPort)
		if connectorError != nil {
			server.SetConnectorUnavailable("port-in-use")
			log.Printf("NeoRead Connector unavailable: %v", connectorError)
		} else {
			server.SetConnectorAvailable(true)
			server.SetCitePlugins(*citePlugins)
			if *citeCredential == "" {
				if config, configErr := os.UserConfigDir(); configErr == nil {
					*citeCredential = filepath.Join(config, "Reader", "cite-credential")
				}
			}
			if *citeCredential != "" {
				if credentialErr := server.SetCiteCredential(*citeCredential); credentialErr != nil {
					log.Printf("citation plugins unavailable: %v", credentialErr)
				}
			}
			connectorHTTP := &http.Server{Handler: server.ConnectorHandler(), ReadHeaderTimeout: 10 * time.Second}
			go func() { _ = connectorHTTP.Serve(connectorListener) }()
			defer connectorHTTP.Shutdown(context.Background())
		}
	}
	runContext, cancelRun := context.WithCancel(context.Background())
	defer cancelRun()
	stopProcessing := server.StartProcessing(runContext)
	defer stopProcessing()
	httpServer := &http.Server{BaseContext: func(net.Listener) context.Context { return runContext }, Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	removeDiscovery, discoveryErr := neoread.WriteDiscovery(root, neoread.Discovery{URL: "http://" + listener.Addr().String(), Token: token, PID: os.Getpid(), Version: neoreadVersion})
	if discoveryErr != nil {
		log.Printf("command line discovery unavailable: %v", discoveryErr)
	} else {
		defer removeDiscovery()
	}
	ready, _ := json.Marshal(map[string]string{"url": "http://" + listener.Addr().String(), "token": token})
	fmt.Println(string(ready))
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	if *shutdownOnStdin {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop <- os.Interrupt
		}()
	}
	go func() {
		<-stop
		slog.Info("server.stopping")
		cancelRun()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}()
	if err = httpServer.Serve(listener); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
