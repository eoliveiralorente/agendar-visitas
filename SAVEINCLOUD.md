# Agenda de Visitas no Kubernetes da SaveInCloud

Passo a passo para colocar o app no ar num cluster Kubernetes da SaveInCloud (painel **Computar → Kubernetes**, baseado em OpenStack/Magnum), do zero. Este é o caminho usado no cluster **k8s-auto**.

**O que vai rodar no cluster:**

| Peça | Como |
|---|---|
| App (2 réplicas) | Imagem `ghcr.io/eoliveiralorente/agendar-visitas`, gerada pelo GitHub Actions |
| Banco | PostgreSQL 16 num StatefulSet, disco `local-path` |
| Acesso externo | Ingress no **Traefik** que já vem no cluster (IP público do balanceador) |
| Endereço | `https://200-229-75-14.sslip.io` (sslip.io transforma o IP em domínio, sem cadastro) |
| HTTPS | cert-manager + Let's Encrypt (gratuito, renova sozinho) |
| Login | Google (OAuth) da conta @saveincloud.com, com acesso ao Google Calendar |

Tempo estimado na primeira vez: 1 hora.

---

## Passo 0 — O que você precisa

- **kubectl** no seu computador, conectado ao cluster. No painel da SaveInCloud: **Computar → Kubernetes → clique no cluster → Baixar kubeconfig**. Salve o arquivo e use:
  ```bash
  export KUBECONFIG=~/caminho/do/kubeconfig
  kubectl get nodes   # os nós precisam aparecer "Ready"
  ```
- **git** e uma conta no **GitHub**.
- Conta Google da empresa (**@saveincloud.com**) para criar o login.

## Passo 1 — Código no GitHub e imagem

1. Crie o repositório **agendar-visitas** em <https://github.com/new> (sem README, sem .gitignore) e envie o projeto:
   ```bash
   cd ~/agendar-visitas
   git remote add origin git@github.com:eoliveiralorente/agendar-visitas.git
   git push -u origin main
   ```
   Confira que a pasta `deploy/base` foi junto (`ls deploy/base` precisa listar 8 arquivos). Upload pelo site do GitHub pode deixar subpastas para trás.
2. No repositório: **Settings → Actions → General → Workflow permissions → Read and write permissions → Save**.
3. Aba **Actions**: o workflow **build** roda a cada push. Espere ficar ✅ verde.
4. Deixe a imagem pública para o cluster baixar sem senha: <https://github.com/users/eoliveiralorente/packages/container/agendar-visitas/settings> → **Change visibility → Public**.

> Se o build falhar com `permission_denied: write_package`, existe um pacote com o mesmo nome ligado a outro repositório (por exemplo, um repositório apagado). Apague o pacote antigo ou, nas configurações dele, em **Manage Actions access**, dê acesso **Write** ao repositório atual.

## Passo 2 — Conhecer o cluster

```bash
kubectl get storageclass        # tipos de disco
kubectl get ingressclass        # deve aparecer: traefik
kubectl -n traefik get svc      # EXTERNAL-IP = IP público do app
```

No k8s-auto o resultado foi:
- **StorageClass:** `cinder` e `local-path`, **nenhuma padrão**. Por isso o overlay define o disco do banco explicitamente. O `cinder` exige cota de volumes no projeto; com cota 0 GB o disco não é criado. Por enquanto usamos `local-path` (disco do próprio nó).
- **IngressClass:** `traefik`.
- **IP do Traefik:** `200.229.75.14`. O endereço do app fica `200-229-75-14.sslip.io` (o IP com hífens + `.sslip.io`). Se o seu IP for outro, troque nos arquivos do passo 5.

## Passo 3 — HTTPS (cert-manager), uma vez por cluster

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=180s
kubectl apply -f deploy/cert-manager/clusterissuer.yaml
```

## Passo 4 — Login Google

Entre no console com a conta **@saveincloud.com**.

1. <https://console.cloud.google.com/>: crie o projeto **agenda-visitas** (dentro da organização saveincloud.com, se a opção aparecer).
2. Ative a API: <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com> → **Enable**.
3. <https://console.cloud.google.com/auth/overview> → **Get started**:
   - **App name:** *Agenda de Visitas*; e-mail de suporte: o seu.
   - **Audience:** **Internal**. Só contas @saveincloud.com entram, sem lista de testadores e sem verificação do Google. Essa opção só existe se o projeto estiver na organização.
   - Se precisar usar **External**: em <https://console.cloud.google.com/auth/audience> → **Test users → Add users**, adicione o e-mail de **cada** pessoa que vai usar (até 100). Quem não estiver na lista recebe "Acesso bloqueado… não concluiu o processo de verificação" (erro 403 access_denied).
4. <https://console.cloud.google.com/auth/clients> → **Create client** → **Web application**:
   - **Authorized redirect URIs:** `https://200-229-75-14.sslip.io/auth/callback`
   - **Create** e copie o **Client ID** e o **Client secret**.

## Passo 5 — Ajustar a configuração

Arquivo `deploy/overlays/saveincloud/kustomization.yaml`:
- `BASE_URL`: `https://200-229-75-14.sslip.io` (sem barra no final; igual ao redirect URI sem o `/auth/callback`);
- `ALLOWED_DOMAINS`: `saveincloud.com` (ou use `ALLOWED_EMAILS` com uma lista de e-mails separados por vírgula);
- disco do banco: `local-path` (troque por `cinder` quando houver cota).

Arquivo `deploy/overlays/saveincloud/ingress.yaml`: o host `200-229-75-14.sslip.io` aparece duas vezes.

## Passo 6 — Segredos

```bash
kubectl create namespace agenda-visitas

PG_PASS=$(openssl rand -hex 16)
kubectl -n agenda-visitas create secret generic agenda-visitas-secrets \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
  --from-literal=GOOGLE_CLIENT_ID='COLE-O-CLIENT-ID' \
  --from-literal=GOOGLE_CLIENT_SECRET='COLE-O-CLIENT-SECRET' \
  --from-literal=POSTGRES_PASSWORD=$PG_PASS \
  --from-literal=DATABASE_URL="postgres://agenda:$PG_PASS@postgres:5432/agenda"
```

Ainda não tem o Client ID? Crie o segredo com o texto `provisorio` nos dois campos do Google e troque depois.

**Para trocar só as chaves do Google depois** (nunca recrie o segredo inteiro depois que o banco subiu: a senha nova não bate com a do banco):
```bash
kubectl -n agenda-visitas patch secret agenda-visitas-secrets --type merge \
  -p '{"stringData":{"GOOGLE_CLIENT_ID":"COLE-O-CLIENT-ID","GOOGLE_CLIENT_SECRET":"COLE-O-CLIENT-SECRET"}}'
kubectl -n agenda-visitas rollout restart deploy/agenda-visitas
```

## Passo 7 — Subir

```bash
kubectl apply -k deploy/overlays/saveincloud
kubectl -n agenda-visitas get pods -w        # Ctrl+C para sair
```
O esperado: `postgres-0` e dois `agenda-visitas-...` em **Running 1/1**. O app reinicia algumas vezes até o banco ficar pronto; isso é normal. Se demorar, force:
```bash
kubectl -n agenda-visitas rollout restart deploy/agenda-visitas
```

Certificado (1 a 2 minutos):
```bash
kubectl -n agenda-visitas get certificate     # READY = True
```

## Passo 8 — Testar

1. Abra **https://200-229-75-14.sslip.io** (deve abrir com cadeado).
2. **Entrar com Google** → aceite a permissão da agenda. Pode aparecer "app não verificado": clique em **Continuar**.
3. **Painel → Equipe:** cadastre as pessoas com o e-mail @saveincloud.com de cada uma.
4. Crie uma visita com **Criar no Google Calendar** ligado e confira o evento na agenda (aparece "Google ✓" no card).
5. **Leads → Importar planilha** para trazer a planilha atual.

---

## Dia a dia

**Atualizar o app:** faça `git push`. Quando o Actions ficar verde:
```bash
kubectl -n agenda-visitas rollout restart deploy/agenda-visitas
```
Se mudou algo em `deploy/`: `git pull && kubectl apply -k deploy/overlays/saveincloud` antes.

**`git push` recusado (fetch first):** o Actions também faz commits no repositório. Rode `git pull --rebase && git push`.

**Backup do banco** (importante com `local-path`, que fica no disco do nó):
```bash
kubectl -n agenda-visitas exec statefulset/postgres -- pg_dump -U agenda agenda > backup-$(date +%F).sql
```

**Restaurar um backup:**
```bash
kubectl -n agenda-visitas exec -i statefulset/postgres -- psql -U agenda agenda < backup-AAAA-MM-DD.sql
```

## Migrar o banco para o Cinder (quando a cota for liberada)

1. Faça o backup (acima).
2. Troque `local-path` por `cinder` no `kustomization.yaml`.
3. Recrie o banco (o disco de um StatefulSet não pode ser alterado):
   ```bash
   kubectl -n agenda-visitas delete statefulset postgres
   kubectl -n agenda-visitas delete pvc data-postgres-0
   kubectl apply -k deploy/overlays/saveincloud
   ```
4. Quando o `postgres-0` estiver Running, restaure o backup e reinicie o app.

## Usar um domínio próprio

1. No DNS, crie um registro **A**: `visitas.suaempresa.com.br` → IP do Traefik.
2. Troque `200-229-75-14.sslip.io` pelo domínio no `ingress.yaml` (2 lugares) e no `BASE_URL`.
3. No Google, adicione o redirect URI `https://visitas.suaempresa.com.br/auth/callback`.
4. `kubectl apply -k deploy/overlays/saveincloud && kubectl -n agenda-visitas rollout restart deploy/agenda-visitas`.

## Problemas que já apareceram e a solução

| Sintoma | Causa | Solução |
|---|---|---|
| `kubectl apply -k` → `deploy/base: no such file` | Pasta `deploy/base` não subiu | Envie a pasta para o repositório e rode `git pull` |
| Build: `permission_denied: write_package` | Pacote ligado a outro repositório | Veja a nota do passo 1 |
| App em `CreateContainerConfigError` | Segredo `agenda-visitas-secrets` não existe | Passo 6 |
| `postgres-0` em `Pending` / PVC "unbound" | Nenhuma StorageClass padrão | O overlay já define o disco; confira o patch do StatefulSet |
| PVC `ProvisioningFailed … quota is 0G` | Projeto sem cota de volumes no Cinder | Use `local-path` ou peça aumento de cota |
| App em `CrashLoopBackOff` com `ECONNREFUSED …:5432` | Banco ainda não subiu | Espere o `postgres-0` e faça `rollout restart` |
| Navegador: `404 page not found` (resposta do Traefik) | Ingress em outro namespace ou classe errada | `kubectl get ingress -A`: precisa estar em `agenda-visitas` com classe `traefik`. Logs: `kubectl -n traefik logs deploy/traefik --tail=20` |
| Google: erro 400 / política OAuth | Endereço sem HTTPS/domínio | Use o endereço sslip.io com certificado (passos 3 e 5) |
| Google: `invalid_client` | Segredo com `provisorio` ou ID errado | `patch` do passo 6 |
| Google: `redirect_uri_mismatch` | Redirect URI diferente do `BASE_URL` | Os dois precisam ser idênticos |
| Google: "app não concluiu a verificação" (403) | Público External sem o usuário em Test users | Adicione o e-mail ou mude para Internal |
| App: "Sua conta não tem acesso" | E-mail fora de `ALLOWED_DOMAINS`/`ALLOWED_EMAILS` | Ajuste, `kubectl apply -k …` e `rollout restart.` |
