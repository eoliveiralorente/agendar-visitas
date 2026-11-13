# Agenda de Visitas

> **Vai subir no Kubernetes da SaveInCloud e não tem ArgoCD nem pipeline montado?** Siga o guia passo a passo do zero: [SAVEINCLOUD.md](SAVEINCLOUD.md).

Sistema para a pré-vendas registrar os leads, o comercial (arquitetos de soluções, vendedores) e o Customer Success agendarem e registrarem visitas, e o gerente acompanhar tudo num painel. As visitas vão para o Google Calendar de quem agenda, com convite para o responsável.

- **Front:** uma página só (`public/index.html`), funciona no computador e no celular.
- **Backend:** Node.js 22, sem framework (`server/`), única dependência `pg`.
- **Banco:** PostgreSQL (ou memória, para desenvolvimento).
- **Login:** Google (OAuth 2.0). O mesmo login dá acesso à agenda da pessoa no Google Calendar.
- **Implantação:** Docker + Kubernetes (Kustomize) + ArgoCD, com build automático no GitHub Actions.

## Estrutura

```
server/            backend (API, login Google, Google Calendar, banco)
public/            front (index.html)
data/exemplo.json  dados de demonstração (opcional)
test/              testes (npm test)
deploy/base        manifests Kubernetes: app, Postgres, Service, PDB, ConfigMap
deploy/overlays/prod  Ingress, domínio e tag da imagem de produção
deploy/argocd      Application do ArgoCD
.github/workflows  build da imagem e atualização da tag (GitOps)
```

## 1. Rodar localmente

```bash
npm install
npm run dev            # http://localhost:8080, banco em memória
```

Na tela de login aparece **"Entrar em modo desenvolvimento"**, que entra sem Google (só funciona fora de produção). A criação de eventos no Google Calendar é simulada nesse modo.

Para testar com PostgreSQL e Google de verdade, copie `.env.example` para `.env`, preencha e rode com as variáveis carregadas (por exemplo `node --env-file=.env server/index.js`).

Depois do primeiro `npm install`, comite o `package-lock.json` gerado: o Dockerfile passa a usar `npm ci`.

## 2. Configurar o login Google (Google Cloud Console)

1. Acesse <https://console.cloud.google.com/> e crie um projeto (ex.: *agenda-visitas*).
2. **APIs e serviços → Biblioteca:** ative a **Google Calendar API**.
3. **APIs e serviços → Tela de consentimento OAuth** (Google Auth Platform):
   - Tipo de usuário: **Interno** se a equipe usa Google Workspace da empresa (não precisa de verificação do Google); **Externo** se forem contas @gmail.
   - Escopos: `openid`, `email`, `profile` e `https://www.googleapis.com/auth/calendar.events`.
   - Se for **Externo**, enquanto o app estiver em modo *Teste*, adicione o e-mail de cada pessoa em **Usuários de teste** (limite de 100). Para liberar geral, é preciso publicar o app e passar pela verificação do Google, porque o escopo do Calendar é sensível.
4. **Credenciais → Criar credenciais → ID do cliente OAuth → Aplicativo da Web:**
   - URI de redirecionamento autorizado: `https://SEU-DOMINIO/auth/callback`
   - (Opcional, para testes locais) `http://localhost:8080/auth/callback`
5. Guarde o **Client ID** e o **Client Secret**.

## 3. Implantar no Kubernetes com ArgoCD

### 3.1 Publicar a imagem
O workflow `.github/workflows/build.yaml` roda a cada push na `main`: testa, gera a imagem, publica em `ghcr.io/eoliveiralorente/agenda-visitas` e grava a tag nova em `deploy/overlays/prod/kustomization.yaml`. O ArgoCD vê o commit e atualiza o cluster.

No GitHub, em **Settings → Actions → General → Workflow permissions**, marque **Read and write permissions**.

Se o pacote no GHCR ficar **privado**, crie no cluster o segredo de pull usado pelo Deployment:

```bash
kubectl create namespace agenda-visitas
kubectl -n agenda-visitas create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=eoliveiralorente \
  --docker-password=SEU_TOKEN_COM_read:packages
```

Se deixar o pacote **público**, não precisa desse segredo.

### 3.2 Ajustar domínio e acesso
Edite `deploy/overlays/prod/kustomization.yaml` e `deploy/overlays/prod/ingress.yaml`:
- troque `visitas.example.com` pelo seu domínio (nos dois arquivos);
- preencha `ALLOWED_DOMAINS` (ex.: `suaempresa.com.br`) e/ou `ALLOWED_EMAILS` (lista separada por vírgula). Se os dois ficarem vazios, qualquer conta Google consegue entrar;
- ajuste `ingressClassName` e o `cluster-issuer` do cert-manager conforme o seu cluster.

### 3.3 Criar os segredos (fora do Git)

```bash
PG_PASS=$(openssl rand -hex 16)
kubectl -n agenda-visitas create secret generic agenda-visitas-secrets \
  --from-literal=SESSION_SECRET=$(openssl rand -hex 32) \
  --from-literal=GOOGLE_CLIENT_ID='xxxx.apps.googleusercontent.com' \
  --from-literal=GOOGLE_CLIENT_SECRET='GOCSPX-xxxx' \
  --from-literal=POSTGRES_PASSWORD=$PG_PASS \
  --from-literal=DATABASE_URL="postgres://agenda:$PG_PASS@postgres:5432/agenda"
```

Prefere GitOps também para segredos? Use Sealed Secrets ou External Secrets com as mesmas chaves (modelo em `deploy/base/secret.example.yaml`).

### 3.4 Registrar no ArgoCD

```bash
kubectl apply -f deploy/argocd/application.yaml
```

Se o repositório for privado, cadastre-o antes no ArgoCD (**Settings → Repositories**) com um token de leitura.

### 3.5 Conferir

```bash
kubectl -n agenda-visitas get pods
kubectl -n agenda-visitas logs deploy/agenda-visitas
```

Abra `https://SEU-DOMINIO`, entre com o Google e cadastre a equipe em **Painel → Equipe** com o e-mail de cada pessoa.

## 4. Dados de demonstração (opcional)

```bash
kubectl -n agenda-visitas port-forward svc/postgres 5432:5432 &
DATABASE_URL="postgres://agenda:SENHA@localhost:5432/agenda" node server/import.js data/exemplo.json
```

O mesmo script importa qualquer JSON no formato `{ "clientes": [], "visitas": [], "leads": [], "equipe": [] }`. A planilha atual de leads pode ser importada pela própria tela **Leads → Importar planilha**.

## 5. Banco de dados em produção

O `deploy/base/postgres.yaml` sobe um PostgreSQL de uma réplica com volume de 5 GiB, suficiente para começar. Para produção séria, considere:
- **CloudNativePG** (operador) com backups agendados, ou um Postgres gerenciado;
- se trocar, remova `postgres.yaml` do `kustomization.yaml` da base e aponte o `DATABASE_URL` para o novo banco (com `DATABASE_SSL=true` se exigir TLS).

Backup rápido do Postgres do cluster:

```bash
kubectl -n agenda-visitas exec statefulset/postgres -- pg_dump -U agenda agenda > backup.sql
```

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `BASE_URL` | sim (prod) | URL pública, usada no redirecionamento do login |
| `DATABASE_URL` | sim (prod) | Conexão PostgreSQL. Sem ela, usa memória |
| `SESSION_SECRET` | sim (prod) | Assina as sessões e cifra os tokens do Google |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | sim (prod) | Credenciais OAuth |
| `ALLOWED_DOMAINS` / `ALLOWED_EMAILS` | recomendado | Quem pode entrar |
| `COOKIE_SECURE` | não | `true` por padrão em produção (exige HTTPS) |
| `DATABASE_SSL` | não | `true` para conexão TLS com o banco |
| `SESSION_DAYS` | não | Validade da sessão (padrão 30) |
| `TZ_EVENTS` | não | Fuso dos eventos (padrão `America/Sao_Paulo`) |

## Segurança

- Sessão em cookie `HttpOnly`, `SameSite=Lax`, assinado com HMAC; chamadas que alteram dados exigem o cabeçalho `X-Requested-With`.
- Tokens do Google guardados cifrados (AES-256-GCM).
- Acesso restrito por domínio ou lista de e-mails.
- Contêiner sem root, sistema de arquivos somente leitura, sem capabilities.
- Todos os usuários liberados enxergam e editam os dados da equipe (não há perfis de permissão nesta versão).

## Endpoints

| Método | Caminho | Uso |
|---|---|---|
| GET | `/healthz`, `/readyz` | Probes do Kubernetes |
| GET | `/auth/google`, `/auth/callback`, `/auth/logout` | Login |
| GET | `/api/me`, `/api/users`, `/api/data` | Usuário, equipe logada, todos os registros |
| PUT/PATCH/DELETE | `/api/data/{clientes\|visitas\|leads\|equipe}/{id}` | Gravar, mesclar, excluir |
| POST | `/api/gcal/events` | Criar evento no Google Calendar de quem está logado |
