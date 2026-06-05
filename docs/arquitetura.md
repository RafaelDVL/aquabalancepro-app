# Arquitetura do Sistema AquaBalancePro

Este documento descreve a arquitetura técnica do sistema **AquaBalancePro**, composto por um aplicativo móvel e um controlador de hardware baseado em ESP32.

## Visão Geral

O sistema é projetado para automação de dosagem em aquários marinhos (Reef), permitindo controle preciso de bombas peristálticas via Wi-Fi.

```mermaid
graph TD
    User[Usuário] -->|Interface UI| App[App Mobile (Ionic/Angular)]
    App -->|HTTP REST| ESP[Controlador ESP32]
    ESP -->|GPIO| Pumps[Bombas Dosadoras]
    ESP -->|I2C| RTC[Relógio DS3231]
    ESP -->|LittleFS| Logs[Logs Internos]
```

## Componentes

### 1. Aplicativo Móvel (Frontend)

- **Framework**: Ionic 8 + Angular 20
- **Estilo**: Tailwind CSS + Ionic Components
- **Funcionalidades**:
  - Monitoramento de status em tempo real.
  - Configuração de agendamentos de dosagem.
  - Calibração de bombas.
  - Visualização de Logs e Gráficos.

### 2. Firmware (Backend Embarcado)

- **Microcontrolador**: ESP32-S3
- **Framework**: PlatformIO / Arduino
- **Funcionalidades**:
  - **Servidor Web Assíncrono**: `ESPAsyncWebServer`
  - **Relógio de Tempo Real (RTC)**: `DS3231` para manter a hora precisa mesmo sem internet.
  - **Sistema de Arquivos**: `LittleFS` para armazenar logs e configurações.
  - **Gerenciamento de Wi-Fi**: Modos AP (Access Point) e STA (Station) simultâneos ou alternados.

## Protocolo de Comunicação (API)

O ESP32 expõe uma API RESTful na porta 80.

| Método   | Endpoint  | Descrição                                    | Corpo (JSON)                                      |
| -------- | --------- | -------------------------------------------- | ------------------------------------------------- |
| `GET`    | `/status` | Retorna status do dispositivo, hora e Wi-Fi. | -                                                 |
| `GET`    | `/config` | Retorna a configuração atual das bombas.     | -                                                 |
| `POST`   | `/config` | Atualiza configurações das bombas.           | `{ "bombas": [...] }`                             |
| `POST`   | `/dose`   | Comanda uma dosagem manual imediata.         | `{ "bomb": 1, "dosagem": 10.5, "origem": "App" }` |
| `POST`   | `/time`   | Sincroniza o relógio RTC.                    | `{ "time": "2024-02-07 10:00" }`                  |
| `GET`    | `/logs`   | Retorna o histórico de dosagens.             | -                                                 |
| `DELETE` | `/logs`   | Limpa o histórico de logs.                   | -                                                 |

## Estrutura de Dados (Firmware)

### Bomba

Cada bomba possui:

- **Nome**: Identificador (ex: "Cálcio").
- **Fator de Calibração**: Tempo (ms) para dosar 1ml.
- **Estoque**: Quantidade restante no reservatório.
- **Agendamentos**: Até 3 horários configuráveis por dia.

### Agendamento (Schedule)

- Hora/Minuto de execução.
- Volume a dosar.
- Dias da semana ativos.

## Mecanismos de Segurança

- **Fila de Dosagem**: Evita acionamento simultâneo de bombas para proteger a fonte de alimentação.
- **Watchdog de Conexão**: Reconecta ao Wi-Fi automaticamente se cair.
- **Logs Persistentes**: Registra todas as dosagens (automáticas ou manuais) na memória flash.
