package common

import (
	"os"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
)

var Logger *zap.Logger

func new(encoderCfg zapcore.EncoderConfig, level zapcore.Level) (*zap.Logger, error) {
	file, err := os.OpenFile(
		"app.log",
		os.O_APPEND|os.O_CREATE|os.O_WRONLY,
		0644,
	)
	if err != nil {
		return nil, err
	}

	encoderCfg.TimeKey = "timestamp"
	encoderCfg.EncodeTime = zapcore.ISO8601TimeEncoder

	consoleEncoder := zapcore.NewConsoleEncoder(encoderCfg)
	fileEncoder := zapcore.NewJSONEncoder(encoderCfg)

	core := zapcore.NewTee(
		zapcore.NewCore(consoleEncoder, zapcore.AddSync(os.Stdout), level),
		zapcore.NewCore(fileEncoder, zapcore.AddSync(file), level),
	)

	// Stacktrace only above Error: Error is the common case for a handled,
	// expected failure (bad input, no rows, a downstream 4xx) and a 20+ frame
	// dump of echo/net/http internals on every one of those bodies the real
	// signal — the "caller" field on ORM logs (core/orm/log.LogEntry) already
	// names the actual source line without it. Reserve the full stack for
	// DPanic/Fatal, where something is about to crash and every frame matters.
	return zap.New(core, zap.AddCaller(), zap.AddStacktrace(zap.DPanicLevel)), nil
}

func InitLogger(debug bool) error {
	var err error
	if debug {
		Logger, err = new(zap.NewDevelopmentEncoderConfig(), zap.DebugLevel)
	} else {
		Logger, err = new(zap.NewProductionEncoderConfig(), zap.InfoLevel)
	}

	return err
}
