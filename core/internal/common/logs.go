package common

import (
	"core/internal/common/editstring"
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

	return zap.New(core, zap.AddCaller(), zap.AddStacktrace(zap.ErrorLevel)), nil
}

func InitLogger(logLevel string) error {
	var err error

	loglv := editstring.LowedNoSpaces(editstring.Clean(logLevel))

	switch loglv {
	case "debug":
		Logger, err = new(zap.NewDevelopmentEncoderConfig(), zap.DebugLevel)
	default:
		Logger, err = new(zap.NewProductionEncoderConfig(), zap.InfoLevel)
	}

	return err
}
