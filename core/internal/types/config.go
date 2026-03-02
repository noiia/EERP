package types

// Config fields
type Config struct {
	ModuleRoot     []string `json:"module_root" needed:"true"`
	MasterPassword string   `json:"master_key" needed:"false"`
	ContainerPool  int      `json:"container_pool" needed:"false"`
	ThreadPool     int      `json:"thread_pool" needed:"false"`
	DbName         string   `json:"db_name" needed:"false"`
	DbPort         int      `json:"db_port" needed:"true"`
	DbHost         string   `json:"db_host" needed:"true"`
	DbUser         string   `json:"db_user" needed:"true"`
	DbPassword     string   `json:"db_password" needed:"true"`
}
